# M1: Walking skeleton (learner app, local-first)

Goal: prove the riskiest path end to end on a real budget Android phone. A guardian signs in, creates a child
profile and a grown-up PIN, downloads a published unit on Wi-Fi, switches to airplane mode, plays the unit, passes
the deterministic mastery check (which unlocks the next unit), reconnects, and the progress events sync.

## Work packages

| #    | Package                                                                                                                                                                       | Where                                                          | Status                                           |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------ |
| M1.1 | Local-first engine: ports, SQLite schema + migrations, outbox sync, pack download manager, lesson session, deterministic mastery, PIN gate, trusted clock, wire contract      | `packages/learner-core`, `packages/content-schema/src/pack.ts` | in progress                                      |
| M1.2 | Learner app: sign-in (email OTP), child picker, home with mastery-gated units, lesson player, grown-ups PIN gate, downloads, sync status; Expo platform adapters; demo mode   | `apps/learner`                                                 | in progress                                      |
| M1.3 | Server: `progress_events` (append-only), derived `unit_progress`, `ingest_progress_events` and `sync_pull` RPCs, pack storage + `get_pack_download`, pack builder/publish job | `supabase/`, `scripts/`                                        | waits for M0 database sign-off                   |
| M1.4 | Device test: EAS preview build, airplane-mode run, sync check                                                                                                                 | your phone                                                     | needs an Expo account and a budget Android phone |

## Contracts

- Ports (platform seams): `packages/learner-core/src/ports.ts`.
- Server contract: `packages/learner-core/src/wire.ts` (events, `sync_pull`, `get_pack_download`). The SQL in M1.3 must match it exactly.
- Pack format: `packages/content-schema/src/pack.ts` (ADR 0004).
- Sync rules: ADR 0003. Guardian session and PIN elevation: ADR 0002.

## Demo mode

With no `EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_KEY`, the app runs against an in-memory fake server
seeded with the golden unit, so the whole flow (sign in, download, play, master, sync) can be exercised and
screenshotted on web without a backend. Native builds use the real project once the keys are set.

## Known limits in M1 (deliberate)

- Mastery results are graded on the device and trusted by the server. Server-side re-grading is a later hardening step.
- Downloads resume per file, not per byte range (small files; see `expoFiles.ts`).
- No tutor chat, voice, worksheets or admin content engine yet (M2 and later).
- Offline learning is native-only; the web build is for grown-ups and demos.

## Exit criteria

1. Airplane-mode completion of a unit on a real Android phone, with events syncing on reconnect (M1.4).
2. Engine tests green (idempotent push, poison-row dead-letter, epoch purge, resume, hash mismatch, atomic swap, clock rollback, PIN lockout).
3. pgTAP tests green for the new tables and RPCs (M1.3).
4. `npm run typecheck`, `lint`, `test`, `format:check` green; web export of the learner app screenshotted.
