# @custar/learner-core

The local-first engine behind the offline learner app (Milestone M1). Pure TypeScript: no React, Expo or
Supabase imports. Everything platform-specific is injected through small **ports**, so the same code runs on a
budget Android phone, in the browser demo mode and in Vitest.

```
 UI (apps/learner)                       src/index.ts  ->  @custar/learner-core
   |
   |  LessonSession   DownloadManager    PinGate        mastery.ts   TrustedClock
   |  (events)        (packs)            (grown-up)     (rules)      (time)
   |        \             |                  |
   |         \            |                  |
   |        SQLite  <-- db/ (migrations, repositories) --> outbox ---> SyncEngine ---> SyncApi (server port)
   |                                                                     push, then pull
   +--> ports: SqlDriver  FileStore  Downloader  Hasher  SecureKv  Clock  Random  Network
```

Three entry points:

| Import                         | Contains                                                                                   | Platform |
| ------------------------------ | ------------------------------------------------------------------------------------------ | -------- |
| `@custar/learner-core`         | the engine, the ports, the server contract (`wire.ts`)                                     | neutral  |
| `@custar/learner-core/fakes`   | in-memory ports, `FakeSyncApi` (a whole fake server), `createDemoServer`, `buildPackFiles` | neutral  |
| `@custar/learner-core/testing` | `NodeSqliteDriver` (`node:sqlite`) and `createTestPorts()`                                 | Node     |

`purity.test.ts` fails the build if anything outside `src/testing` imports a Node built-in, React Native, Expo or
Supabase. The only ambient globals used are `AbortSignal` (in the `Downloader` port) and, optionally,
`crypto.subtle` / `TextEncoder` (with pure-JS fallbacks).

## What is in here

| File / folder        | Job                                                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `ports.ts`           | The platform ports (`SqlDriver`, `FileStore`, `Downloader`, `Hasher`, `SecureKv`, `Clock`, `Random`, `Network`).             |
| `wire.ts`            | **The server contract**: Zod schemas for every RPC payload, documented field by field. The SQL is written against this file. |
| `api.ts`             | `SyncApi`, the server port, and `SyncApiError` with its codes.                                                               |
| `db/`                | Ordered SQLite migrations (`PRAGMA user_version`) and one repository file per concern.                                       |
| `mastery.ts`         | Deterministic mastery: `gradeMasteryCheck`, `deriveUnitProgress`, `effectiveProgress`, `unlockStates`.                       |
| `session.ts`         | `LessonSession`: turns play into events (local log + outbox, one transaction).                                               |
| `sync/`              | `SyncEngine.syncOnce()`: push the outbox, then pull changes by `sync_seq`.                                                   |
| `packs/`             | `DownloadManager`: resumable, verified, atomically activated lesson packs; loading; release; storage meter.                  |
| `pin.ts`             | `PinGate`: local UI gate with lockout, plus the real server-side elevation.                                                  |
| `clock.ts`           | `TrustedClock`: monotonic time and the offline grace window.                                                                 |
| `fakes/`, `testing/` | See below.                                                                                                                   |

The pack format itself (`PackManifest`, `splitUnitForPacks`, `verifyManifestIntegrity`) lives in
`@custar/content-schema` (`pack.ts`), because the Node pack builder and the publish job use it too.

## Wiring the ports in the app

```ts
import {
  DownloadManager,
  LessonSession,
  PinGate,
  SyncEngine,
  TrustedClock,
  getOrCreateDeviceId,
  migrate,
} from '@custar/learner-core';

const db = createExpoSqliteDriver(); // your adapter, see "SqlDriver" below
await migrate(db); // safe on every launch

const trusted = await TrustedClock.create(db, { now: () => Date.now() });
const ports = { db, files, downloader, hasher, secure, random, clock: trusted }; // trusted clock everywhere
const api: SyncApi = createSupabaseSyncApi(supabase);

const sync = new SyncEngine({ ports, api, trustedClock: trusted });
const downloads = new DownloadManager({
  ports,
  api,
  network,
  appVersion: Application.nativeApplicationVersion,
});
const pin = new PinGate({ ...ports, api, deviceId: () => getOrCreateDeviceId(db, ports.random) });
```

Call `trusted.checkpoint()` at start-up and when the app goes to the background (the sync engine does it after each
sync); that persists the clock's floor.

### Adapter notes

- **`SqlDriver`** (expo-sqlite). `transaction<T>(fn)` must be exclusive. `withExclusiveTransactionAsync(task)`
  returns `void` and is not available on web (use `withTransactionAsync` there): capture the result of `fn` in a
  closure variable and return it afterwards. The core only ever uses the `tx` argument inside `fn`. Multi-statement
  `exec` is used by the migrations. Enable WAL once at open. Integers must come back as JS numbers.
- **`FileStore` and `Downloader`** resolve every path against the same root (the document directory). Paths in
  this package are always relative (`packs/<unit>/<version>/learner.json`, `blobs/<sha256>`).
  `Downloader.download` writes `dest + '.part'`, renames on success, resumes with `Range` when `resume` is true and a
  `.part` exists, and _returns_ the HTTP status for 401/403 instead of throwing (so the manager can re-sign). It
  _throws_ on transport failure and leaves the `.part` file.
- **`Hasher`**: `sha256FileHex` should stream natively where it can; `sha256Hex` is used for the PIN rounds
  (2000 calls by default), so keep it cheap. `fakes` exports a pure-JS `sha256Hex` fallback.
- **`SyncApi`**: one supabase-js `rpc` per method, argument names in `RPC` (`p_events`, `p_since_seq`, `p_limit`,
  `p_unit_id`, `p_version_no`, `p_device_id`, `p_pin`). `elevate_grownup` returns NULL for a wrong PIN or a lockout:
  throw `SyncApiError('invalid_pin')`. Map transport failures to `offline`, 5xx and 429 to `server`, 401 to
  `unauthenticated`, 403/RLS to `forbidden`. Return raw JSON; the engine validates it with the schemas in `wire.ts`.
  `get_pack_download` cannot be plain SQL (it signs storage URLs): use an edge function with the same JSON.

## How the pieces behave

### Events and progress

`LessonSession` writes each event to `local_event` and `outbox` in one transaction with the next per-device
`device_seq` and a client UUID. The five event types and their payloads are in `wire.ts`.

**Mastery is deterministic (CLAUDE.md rule 4).** The only path to mastery is `submitMasteryCheck()`, which grades the
stored responses to the `mastery_check` section's questions with the offline grader: open-ended kinds (draw,
free_text, spoken) are not scored, partial answers count their fraction, unanswered questions score 0, and a check
with nothing gradable can never pass. `score >= MASTERY_THRESHOLD (0.8)` (rounded to 4 decimals) passes.
`deriveUnitProgress` is the fold the server also runs: commutative and idempotent, so order and duplicates do not
matter and mastery never goes backwards. `effectiveProgress(serverRow, pendingEvents)` is what the UI shows;
`unlockStates(chain, progress)` is the mastery-gated pacing (only lessons gate; projects, revision and assessment
open behind the previous lesson but never gate the next one).

### Sync

`syncOnce()` = **push, then pull**, never throws, single-flight.

- _Push_: oldest non-dead outbox rows by `device_seq`, batches of at most 100. Accepted or duplicate rows are
  deleted. Rejected rows (or rows with no result) get `attempts + 1` and a stored reason, are retried once per
  sync, and are dead-lettered after 5 attempts. Every batch is built from rows after the last one handled, so a
  poison row never blocks the rows behind it, even within one sync. A transport error leaves everything queued and
  returns `{ ok: false, retryable: true }`.
- _Pull_: `api.pull(last_sync_seq, limit)` until `has_more` is false. One transaction per page; the cursor moves
  in the same transaction, so a failed page leaves data and cursor untouched. Tombstones delete local rows (a
  deleted child takes their progress, events and unsent rows with it). If the **membership epoch** (or the household)
  changes, household data is wiped and re-pulled from 0, then events and unsent rows of children the account can no
  longer see are dropped; downloaded packs are kept. Each page anchors the `TrustedClock` to `server_time`.
- Sign-out or account switch: call `purgeAccountData(db)`.

### Packs

`downloadUnit(unitId, versionNo, { wifiOnly })`: network policy, signed URLs, manifest sanity, app version
(`PackTooNewError`), then free space against the bytes still to fetch plus 50 MB (`DiskSpaceError`), then each
missing file with resume, one URL renewal on 401/403, SHA-256 verification (one automatic re-download on mismatch,
then `IntegrityError`), and finally the **atomic swap**: the manifest is written and `pack_active` flips in one
transaction. The previous version stays on disk as `superseded_version_no` until `releaseSuperseded(unitId)`
(call it when the child's session ends); it only deletes files nothing else references, because media is
content-addressed (`blobs/<sha256>`) and shared across versions and units. `loadActiveUnit` /
`loadActiveLesson` parse leniently (unknown block types degrade) and refuse packs newer than the app.
`packStatuses(db)` drives the download/update badges; `storageUsage()` the storage meter; `removeUnit()` deletes a
unit. Work on one unit is serialised.

### PIN and time

`PinGate.verifyLocal` is a **UI gate only** (salted, peppered, 2000-round SHA-256; 5 wrong PINs lock for 30 s,
60 s, 120 s ... up to 15 minutes, persisted in `SecureKv`). `elevate(pin)` sends the PIN to the server
(`elevate_grownup`, ADR 0002), which is the real control; the PIN is never stored. On a new device for an existing
guardian use `adoptServerPin`.

`TrustedClock` never lets `now()` go backwards and tracks the last server verification. `offlineGraceValid()` is false
after 30 days without a sync or if the clock was set back by more than 24 hours. That blocks **sync trust and new
downloads**, never playback: `canPlayOffline()` is always `true`; show `needsReverification()` to the user.

## Testing and demo mode

```ts
import { createTestPorts, createTrustedClock } from '@custar/learner-core/testing'; // Node only
import { createDemoServer, FakeDownloader } from '@custar/learner-core/fakes'; // anywhere
```

- `createTestPorts()` gives a migrated `node:sqlite` database, in-memory files, a `FakeDownloader` wired to a
  `FakeSyncApi`, a `ManualClock`, `SeededRandom`, `MemorySecureKv` and `FakeNetwork`.
- `createDemoServer()` returns a `FakeSyncApi` seeded with a household, two children, two subjects and three
  published units whose packs are built from the content-schema fixtures by `buildPackFiles`, exactly as the real
  pack builder will. The household PIN is `DEMO_PIN`. The app's demo mode passes it as `api` and a `FakeDownloader`
  built with it as the URL resolver; `demo-flow.test.ts` is a complete worked example.
- `FakeSyncApi` can misbehave on demand: `setOffline`, `failNext` / `failOnCall`, `rejectEventsWhere` (poison rows),
  `loseNextPushResponse`, `bumpEpoch` / `revokeChild`, `expireSignedUrls`.

Local SQLite tests run on a different engine than expo-sqlite, so WAL, exclusive transactions and process death
must still be verified on a real budget Android phone (plan section 12).
