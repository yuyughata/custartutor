# ADR 0003: Local-first sync protocol

Status: accepted (M0); implemented from M1

## Context

Lessons must be taken offline on low-end Android phones with unreliable clocks and networks. Progress must reach the
server without conflicts or double counting. Access can be revoked (tutor removed, child deleted) while a device is
offline.

## Decision

- The learner app is **local-first**: `expo-sqlite` (WAL, exclusive transactions, `PRAGMA user_version`
  migrations) is the read model; the network is only a sync layer.
- **Pull** uses a server `sync_seq` (global sequence set by a trigger) as the cursor, **not `updated_at`**
  (out-of-order commits and wrong device clocks). Removal is a **tombstone** (`deleted_at`), never a hard delete.
  A household **membership epoch** change forces a full resync so revoked data is purged locally.
- **Push** uses an outbox of `progress_events`: append-only, with client-generated `client_event_id`, `device_id`
  and a per-device sequence number; unique `(child_id, client_event_id)`; the server stamps `received_at` and
  `sync_seq`. Uploads go through a **batch RPC** with per-row results, a size cap, and a dead-letter after N attempts
  so one bad row never blocks the queue.
- **Derived state** (`unit_progress`, mastery) is computed on the server by an idempotent function over events with
  commutative rules; the client never stores derived state independently and the server wins on pull. Mastery is
  keyed to `unit_id`, **not `unit_version`**, so republishing never un-masters a child.
- Profile edits use last-write-wins on server time. No other mutable shared state exists.

## Consequences

No merge conflicts for learning data. Slightly more server logic (batch RPC, derivation function). Local SQLite
tests in CI run on a different engine than expo-sqlite, so WAL, transactions and process-death behaviour are
verified on a real budget Android phone from M1.
