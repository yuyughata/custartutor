import { z } from 'zod';
import { PackManifest } from '@custar/content-schema';

/**
 * THE SERVER CONTRACT between the learner app and Supabase. Everything the learner exchanges with the
 * server goes through the RPCs below; each has a Zod schema here, and the SQL (or edge function) must
 * return/accept exactly this JSON. Rules of the road:
 *
 *  - All ids are UUID text. All timestamps are ISO 8601 strings (`...Z` or `...+00:00`), never epoch numbers.
 *  - `sync_seq` is a JSON number (a Postgres bigint, safe below 2^53). `epoch` is an int.
 *  - Unknown extra fields are ignored by the client (forward compatible); missing required fields make the
 *    whole response invalid and sync stops with a non-retryable "protocol" error. Keep this file small and stable.
 *  - RPC argument names carry the repo's `p_` prefix (see `supabase/migrations/*_rpcs.sql`), see `RPC`.
 *
 * Summary
 *
 *   ingest_progress_events(p_events jsonb)            -> jsonb  PushResult[]        (PUSH)
 *   sync_pull(p_since_seq bigint, p_limit int)        -> jsonb  PullResponse        (PULL)
 *   get_pack_download(p_unit_id uuid, p_version_no)   -> jsonb  PackDownload        (PACKS)
 *   elevate_grownup(p_device_id text, p_pin text)     -> timestamptz | null         (existing; ADR 0002)
 *   set_grownup_pin(p_pin text)                       -> void                       (existing; ADR 0002)
 *
 * The TypeScript port that the app implements with supabase-js is `SyncApi` in `api.ts`.
 */

export const RPC = {
  /** `{ p_events: WireEvent[] }` (at most `MAX_PUSH_BATCH`). */
  ingestProgressEvents: 'ingest_progress_events',
  /** `{ p_since_seq: number, p_limit: number }`. */
  syncPull: 'sync_pull',
  /** `{ p_unit_id: string, p_version_no: number }`. */
  getPackDownload: 'get_pack_download',
  /** Existing RPC. `{ p_device_id: string, p_pin: string }` -> `timestamptz`, or NULL for a wrong PIN / lockout. */
  elevateGrownup: 'elevate_grownup',
  /** Existing RPC. `{ p_pin: string }`. */
  setGrownupPin: 'set_grownup_pin',
} as const;

/** The server rejects a push with more events than this; the client never sends more. */
export const MAX_PUSH_BATCH = 100;
/** Largest `p_limit` the server honours for `sync_pull`; larger values are clamped. */
export const MAX_PULL_LIMIT = 500;
/** What the client asks for. */
export const DEFAULT_PULL_LIMIT = 200;

const Uuid = z.guid();
const Iso = z.iso.datetime({ offset: true });
const SyncSeq = z.number().int().min(0);

// ---------------------------------------------------------------------------------------------
// PUSH: ingest_progress_events
// ---------------------------------------------------------------------------------------------

export const EVENT_TYPES = [
  'unit_started',
  'section_completed',
  'question_answered',
  'mastery_check_completed',
  'unit_completed',
] as const;
export const WireEventType = z.enum(EVENT_TYPES);
export type WireEventType = z.infer<typeof WireEventType>;

/**
 * Fields of every event. The server's append-only `progress_events` row is this plus `household_id`
 * (looked up from the child), `received_at` and `sync_seq` (server stamped).
 *
 *  - `client_event_id`  generated on the device (UUID v4). Idempotency key: unique with `child_id`.
 *  - `child_id`         the child profile (alias-only; no real names ever).
 *  - `device_id`        opaque id of the installation (<= 128 chars); same value as `elevate_grownup`.
 *  - `device_seq`       per-device monotonically increasing integer (>= 1). Orders events from one device;
 *                       gaps are normal (dead-lettered events).
 *  - `unit_id`          the unit (NOT the unit version: mastery is keyed to the unit).
 *  - `occurred_at`      device time of the action (monotonic `TrustedClock`; untrusted, never used as a cursor).
 */
const eventBase = {
  client_event_id: Uuid,
  child_id: Uuid,
  device_id: z.string().min(1).max(128),
  device_seq: z.number().int().min(1),
  unit_id: Uuid,
  occurred_at: Iso,
};

/** Result of grading one question. `ungraded` = draw / free_text / spoken or a mismatched response. */
export const QuestionResult = z.enum(['correct', 'incorrect', 'partial', 'ungraded']);
export type QuestionResult = z.infer<typeof QuestionResult>;

/** The child opened the unit (once per play session). Payload: none. */
const UnitStarted = z.object({
  ...eventBase,
  event_type: z.literal('unit_started'),
  payload: z.object({}),
});

/** The child finished a section. `section_id` is the stable content id (`sections[].id`). */
const SectionCompleted = z.object({
  ...eventBase,
  event_type: z.literal('section_completed'),
  payload: z.object({ section_id: z.string().min(1).max(64) }),
});

/**
 * One graded answer (informational: practice and item analysis; it never grants mastery).
 *  - `question_id`  stable content id (`questions` map key).
 *  - `score`        0..1 fraction right, or null when ungraded.
 *  - `attempt`      1 for the first answer to this question in this play session, 2 for the next, ...
 */
const QuestionAnswered = z.object({
  ...eventBase,
  event_type: z.literal('question_answered'),
  payload: z.object({
    question_id: z.string().min(1).max(64),
    result: QuestionResult,
    score: z.number().min(0).max(1).nullable(),
    attempt: z.number().int().min(1),
  }),
});

/**
 * The ONLY event that can make a unit mastered. Computed on the device by deterministic offline grading.
 *  - `score`           0..1, rounded to 4 decimals.
 *  - `passed`          `score >= 0.8` (MASTERY_THRESHOLD). The server SHOULD reject a row where `passed` disagrees
 *                      with `score >= 0.8` or `question_count < 1` (reason `inconsistent_mastery`).
 *  - `question_count`  number of gradable questions the score is out of (>= 0; 0 can never pass).
 *  - `version_no`      the pack version the child played (informational; progress is keyed to the unit).
 */
const MasteryCheckCompleted = z.object({
  ...eventBase,
  event_type: z.literal('mastery_check_completed'),
  payload: z.object({
    score: z.number().min(0).max(1),
    passed: z.boolean(),
    question_count: z.number().int().min(0),
    version_no: z.number().int().min(1),
  }),
});

/** Emitted right after a passing `mastery_check_completed`. Informational (streaks, stars). Payload: none. */
const UnitCompleted = z.object({
  ...eventBase,
  event_type: z.literal('unit_completed'),
  payload: z.object({}),
});

export const WireEvent = z.discriminatedUnion('event_type', [
  UnitStarted,
  SectionCompleted,
  QuestionAnswered,
  MasteryCheckCompleted,
  UnitCompleted,
]);
export type WireEvent = z.infer<typeof WireEvent>;

/** Narrowed event types, handy for derivation code. */
export type WireEventOf<T extends WireEventType> = Extract<WireEvent, { event_type: T }>;

/**
 * Argument of `ingest_progress_events`: 1..100 events, possibly from several children of one household and
 * several units, in `device_seq` order.
 */
export const IngestProgressEventsArgs = z.object({
  p_events: z.array(WireEvent).min(1).max(MAX_PUSH_BATCH),
});

/**
 * One result per input event, matched by `client_event_id` (not by position). The function must NEVER fail
 * the whole call because of one bad row: it validates and inserts each row independently (savepoint or
 * `exception when others`) so a poison row cannot block the rest.
 *
 *  - `accepted`   inserted now.
 *  - `duplicate`  `(child_id, client_event_id)` already exists (a retry after a lost response). Client treats it as done.
 *  - `rejected`   not stored. `reason` is a short machine code: for example `invalid_payload`, `unknown_unit`,
 *                 `no_access_to_child`, `inconsistent_mastery`, `rate_limited`. The client retries a rejected
 *                 row on later syncs and dead-letters it after 5 attempts, without blocking newer rows.
 *
 * Every accepted event also re-derives that child's `unit_progress` row (see `UnitProgressRow`).
 * Authorisation: the caller must be a guardian of the child's household, or a tutor with an active
 * `child_access` grant; anything else is `rejected` / `no_access_to_child`, not an exception.
 */
export const PushStatus = z.enum(['accepted', 'duplicate', 'rejected']);
export type PushStatus = z.infer<typeof PushStatus>;

export const PushResult = z.object({
  client_event_id: Uuid,
  status: PushStatus,
  reason: z.string().max(200).optional(),
});
export type PushResult = z.infer<typeof PushResult>;
export const PushResults = z.array(PushResult);

// ---------------------------------------------------------------------------------------------
// PULL: sync_pull
// ---------------------------------------------------------------------------------------------

/**
 * Syncable rows. Every row carries the table's `sync_seq` (set by trigger from one global sequence on
 * every insert/update) and `deleted_at` (a TOMBSTONE: non-null means "delete this row locally"). A
 * tombstone row must still carry the id fields; other fields may hold their last values.
 */
const syncMeta = { sync_seq: SyncSeq, deleted_at: Iso.nullable() };

export const ChildRow = z.object({
  id: Uuid,
  household_id: Uuid,
  display_alias: z.string().min(1).max(40),
  avatar: z.string().max(64).nullable(),
  level_code: z.enum(['P1', 'P2', 'P3', 'P4', 'P5', 'P6']),
  reading_mode: z.enum(['reader', 'pre_reader']),
  daily_limit_min: z.number().int().min(0).nullable(),
  ...syncMeta,
});
export type ChildRow = z.infer<typeof ChildRow>;

export const SubjectRow = z.object({
  id: Uuid,
  slug: z.string().min(1).max(64),
  name: z.string().min(1),
  kind: z.enum(['core', 'elective', 'extracurricular']),
  curriculum_source: z.enum(['nerdc', 'global']),
  icon: z.string().nullable(),
  colour: z.string().nullable(),
  sort: z.number().int(),
  ...syncMeta,
});
export type SubjectRow = z.infer<typeof SubjectRow>;

/**
 * A unit, flattened for the learner: `chapter_number`/`chapter_title` come from the chapter,
 * `subject_id`/`level_code`/`term` from the chapter's scheme. Only units that have a current published
 * version are sent. `sync_seq` is the unit's own (bump it when the chapter or scheme fields change).
 */
export const UnitRow = z.object({
  id: Uuid,
  subject_id: Uuid,
  chapter_number: z.number().int().min(1),
  chapter_title: z.string(),
  unit_no: z.number().int().min(1),
  week_no: z.number().int().min(1).nullable(),
  kind: z.enum(['lesson', 'mini_project', 'term_project', 'revision', 'assessment']),
  title: z.string(),
  objective: z.string().nullable(),
  stage: z.enum(['absorb', 'connect', 'express']),
  level_code: z.enum(['P1', 'P2', 'P3', 'P4', 'P5', 'P6']),
  term: z.number().int().min(1).max(3),
  ...syncMeta,
});
export type UnitRow = z.infer<typeof UnitRow>;

/**
 * The CURRENT published pack of a unit (from `published_units` where `is_current`). When a new version is
 * published the server emits the new row (higher `version_no`); when a version stops being current or the
 * unit is unpublished it emits that version with `deleted_at` set (a tombstone, which deletes the local
 * row). The client offers the highest non-tombstoned `version_no` for download.
 *  - `content_hash`        equals `PackManifest.content_hash`.
 *  - `pack_manifest_path`  storage path of the manifest (informational; the manifest itself comes from `get_pack_download`).
 */
export const PublishedRow = z.object({
  unit_id: Uuid,
  version_no: z.number().int().min(1),
  schema_version: z.number().int().min(1),
  min_app_version: z.string().min(1),
  content_hash: z.string().min(1),
  pack_manifest_path: z.string().min(1),
  ...syncMeta,
});
export type PublishedRow = z.infer<typeof PublishedRow>;

export const UnitProgressStatus = z.enum(['locked', 'available', 'in_progress', 'mastered']);
export type UnitProgressStatus = z.infer<typeof UnitProgressStatus>;

/**
 * Server-derived progress of one child on one unit, recomputed by an idempotent function over that
 * child's `progress_events` for the unit (commutative: order and duplicates never matter):
 *
 *  - `status`         `mastered` iff any `mastery_check_completed` event has `passed = true`; otherwise
 *                     `in_progress` iff the unit has any event. The server stores only these two values
 *                     (rows exist only for units with events); `locked`/`available` are computed on the
 *                     device from the chapter order, but the schema allows them.
 *  - `mastery_score`  the best `score` over all `mastery_check_completed` events, or null if none.
 *  - `attempts`       the number of distinct `mastery_check_completed` events.
 *  - `last_section`   `section_id` of the `section_completed` event with the greatest
 *                     `(occurred_at, client_event_id)`, or null.
 *  - `updated_at`     the greatest `occurred_at` over the unit's events.
 *
 * Mastery never moves backwards: nothing downgrades `mastered`.
 */
export const UnitProgressRow = z.object({
  child_id: Uuid,
  unit_id: Uuid,
  status: UnitProgressStatus,
  mastery_score: z.number().min(0).max(1).nullable(),
  attempts: z.number().int().min(0),
  last_section: z.string().nullable(),
  updated_at: Iso,
  ...syncMeta,
});
export type UnitProgressRow = z.infer<typeof UnitProgressRow>;

export const HouseholdRow = z.object({ id: Uuid, name: z.string() });
export type HouseholdRow = z.infer<typeof HouseholdRow>;

/**
 * One page of changes. `sync_pull(p_since_seq, p_limit)`:
 *
 *  - Selects syncable rows the CALLER may read (RLS-equivalent: their household's children, curriculum,
 *    current published packs, and their children's progress) with `sync_seq > p_since_seq`, merged across all
 *    tables in ascending `sync_seq`, at most `p_limit` rows in total (clamped to `MAX_PULL_LIMIT`).
 *  - `next_seq`   the greatest `sync_seq` in this page (or `p_since_seq` when the page is empty). The client
 *                 stores it as the new cursor only after it has applied the whole page.
 *  - `has_more`   true when rows with `sync_seq > next_seq` remain. The client loops until false.
 *  - `epoch`      the caller's household membership epoch. It changes whenever access changes (tutor
 *                 grant revoked, member removed, child removed from a grant ...). On a change the client
 *                 wipes its household data and re-pulls from 0, so revoked data is purged. A caller
 *                 without a household gets epoch 0 and `household: null`.
 *  - `server_time` the server's `now()`; anchors the offline grace window (see `TrustedClock`).
 *  - `household`  the caller's household, sent on every page (cheap); null when they have none.
 *  - Tombstones: rows with `deleted_at` set are included (also for rows the caller just lost access to,
 *    when the server can tell). A page with arrays all empty and `has_more = false` means "up to date".
 *
 * Gotcha for the SQL author: a global sequence can be assigned to a transaction that commits LATER than a
 * transaction with a higher number, so a naive cursor can skip rows. Return only rows with
 * `sync_seq < min(in-flight transactions' seq)` (for example by taking a `sync_seq` upper bound under
 * `pg_snapshot_xmin`/advisory lock), or have the trigger serialise on a lock.
 */
export const PullResponse = z.object({
  epoch: z.number().int().min(0),
  next_seq: SyncSeq,
  has_more: z.boolean(),
  server_time: Iso,
  household: HouseholdRow.nullable(),
  children: z.array(ChildRow),
  subjects: z.array(SubjectRow),
  units: z.array(UnitRow),
  published: z.array(PublishedRow),
  unit_progress: z.array(UnitProgressRow),
});
export type PullResponse = z.infer<typeof PullResponse>;

export const SyncPullArgs = z.object({
  p_since_seq: SyncSeq,
  p_limit: z.number().int().min(1).max(MAX_PULL_LIMIT),
});

// ---------------------------------------------------------------------------------------------
// PACKS: get_pack_download
// ---------------------------------------------------------------------------------------------

/**
 * `get_pack_download(p_unit_id, p_version_no)` (an RPC, or an edge function with this same JSON, since SQL
 * cannot sign storage URLs or read storage objects). Authorisation: any household member or granted tutor
 * for a unit that has a non-tombstoned published row with that `version_no`.
 *
 *  - `manifest`    the immutable `PackManifest` (content-schema `pack.ts`).
 *  - `urls`        one signed GET URL per `manifest.files[].path` (every file of BOTH packs; the client
 *                  chooses what to fetch). URLs must honour `Range` requests (resume).
 *  - `expires_at`  when the URLs stop working (at least one hour). The client re-requests on a 401/403.
 */
export const PackDownload = z.object({
  manifest: PackManifest,
  urls: z.record(z.string(), z.url()),
  expires_at: Iso,
});
export type PackDownload = z.infer<typeof PackDownload>;

export const GetPackDownloadArgs = z.object({
  p_unit_id: Uuid,
  p_version_no: z.number().int().min(1),
});

// ---------------------------------------------------------------------------------------------
// Elevation (existing RPCs, ADR 0002)
// ---------------------------------------------------------------------------------------------

/** What `SyncApi.elevateGrownup` resolves to: the server's `elevate_grownup` timestamptz, wrapped. */
export const ElevationResult = z.object({ expires_at: Iso });
export type ElevationResult = z.infer<typeof ElevationResult>;
