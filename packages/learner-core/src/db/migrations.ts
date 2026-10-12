/**
 * Local SQLite schema as ordered, append-only migrations keyed by `PRAGMA user_version`.
 * NEVER edit a shipped migration: add the next one. `version` must be 1, 2, 3 ... without gaps.
 *
 * No foreign keys on purpose: sync pages arrive in `sync_seq` order, not parent-first, and a tombstone for a
 * parent must not cascade into rows the child is still allowed to see. Integrity is kept by the repositories.
 * Timestamps that came from the server (or `occurred_at`) are ISO strings; local bookkeeping times are
 * epoch milliseconds (INTEGER).
 */

export interface Migration {
  version: number;
  name: string;
  /** One or more statements separated by semicolons; run inside one transaction. */
  sql: string;
}

const referenceData: Migration = {
  version: 1,
  name: 'meta and server-synced reference data',
  sql: `
CREATE TABLE meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE household (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL
);

CREATE TABLE child (
  id TEXT PRIMARY KEY NOT NULL,
  household_id TEXT NOT NULL,
  display_alias TEXT NOT NULL,
  avatar TEXT,
  level_code TEXT NOT NULL,
  reading_mode TEXT NOT NULL,
  daily_limit_min INTEGER,
  sync_seq INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX child_household_idx ON child (household_id);

CREATE TABLE subject (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  curriculum_source TEXT NOT NULL,
  icon TEXT,
  colour TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  sync_seq INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE unit (
  id TEXT PRIMARY KEY NOT NULL,
  subject_id TEXT NOT NULL,
  chapter_number INTEGER NOT NULL,
  chapter_title TEXT NOT NULL,
  unit_no INTEGER NOT NULL,
  week_no INTEGER,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  objective TEXT,
  stage TEXT NOT NULL,
  level_code TEXT NOT NULL,
  term INTEGER NOT NULL,
  sync_seq INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX unit_order_idx ON unit (subject_id, level_code, term, chapter_number, unit_no);

CREATE TABLE published (
  unit_id TEXT NOT NULL,
  version_no INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  min_app_version TEXT NOT NULL,
  pack_manifest_path TEXT NOT NULL,
  sync_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (unit_id, version_no)
) WITHOUT ROWID;

-- Server-derived progress (what a pull returned). Never written from local events.
CREATE TABLE unit_progress (
  child_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  status TEXT NOT NULL,
  mastery_score REAL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_section TEXT,
  updated_at TEXT NOT NULL,
  sync_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (child_id, unit_id)
) WITHOUT ROWID;
`,
};

const packs: Migration = {
  version: 2,
  name: 'downloaded lesson packs',
  sql: `
-- One row per manifest file per (unit, version). Media/audio bytes live in blobs/<sha256> and are shared.
CREATE TABLE pack_file (
  unit_id TEXT NOT NULL,
  version_no INTEGER NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('content', 'media', 'audio')),
  pack TEXT NOT NULL CHECK (pack IN ('learner', 'grownup')),
  asset_id TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'partial', 'verified')),
  downloaded_bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (unit_id, version_no, path)
) WITHOUT ROWID;
CREATE INDEX pack_file_sha_idx ON pack_file (sha256);

-- The version the child plays. At most one superseded version is kept until the session ends.
CREATE TABLE pack_active (
  unit_id TEXT PRIMARY KEY NOT NULL,
  version_no INTEGER NOT NULL,
  activated_at INTEGER NOT NULL,
  superseded_version_no INTEGER
) WITHOUT ROWID;
`,
};

const events: Migration = {
  version: 3,
  name: 'outbox and local events',
  sql: `
-- Events waiting to be pushed. payload_json is the complete WireEvent. Dead rows are kept for support.
CREATE TABLE outbox (
  client_event_id TEXT PRIMARY KEY NOT NULL,
  child_id TEXT NOT NULL,
  device_seq INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  dead INTEGER NOT NULL DEFAULT 0 CHECK (dead IN (0, 1))
);
CREATE INDEX outbox_order_idx ON outbox (dead, device_seq);
CREATE INDEX outbox_child_idx ON outbox (child_id);

-- Every event this device produced, for the local effective-progress calculation. synced_at is set when
-- the server accepted it; synced rows are pruned after a while.
CREATE TABLE local_event (
  client_event_id TEXT PRIMARY KEY NOT NULL,
  child_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  device_seq INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  synced_at INTEGER
);
CREATE INDEX local_event_child_unit_idx ON local_event (child_id, unit_id);
`,
};

export const MIGRATIONS: readonly Migration[] = [referenceData, packs, events];

/** The schema version this build of the app expects. */
export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
