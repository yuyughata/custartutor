# ADR 0004: Lesson pack format and publishing

Status: accepted (M0); implemented from M1

## Context

Published units must be downloadable for offline use, updatable without redownloading everything, and safe to swap
while a child is mid-session. Old app versions linger in the field, so content must stay readable across schema
changes. Data costs matter in Nigeria.

## Decision

- A **published unit** is an immutable snapshot (`published_units`) with a `schema_version`. Mastery is keyed to
  `unit_id`, so new snapshots never reset progress.
- A **pack** per published unit is an **immutable manifest** plus **content-addressed media files**. JSON is stored
  uncompressed in the pack (HTTP compression covers transport, which avoids a JS-thread unzip on low-end phones).
- Two packs: a **learner pack** (content, tutor_script, answers needed for offline grading) and a smaller
  **grown-up pack** (teacher manual and helper script). Answers ship in the learner pack because offline grading
  needs them; the threat model is a young child, not an attacker.
- The manifest carries `min_app_version`. The server serves the highest compatible pack. The renderer degrades
  gracefully on unknown block types (`parseUnitLenient`). Content migrates through pure `migrate_vN` functions with
  golden fixtures.
- Section and question IDs are stable across versions (assigned server-side, patches are ID-addressed, and a lint
  rule fails any version that drops IDs), which protects spaced practice and item analysis.
- **Swap atomically**: the previous pack stays on disk until the current session ends.
- **Publish is an idempotent job**: build pack, upload, project `unit_questions`, then flip the `is_current` pointer
  last. Concurrent admin edits are guarded by `base_version_id`.
- The download manager keeps per-file state in SQLite, re-signs URLs on resume, survives process death, checks free
  disk first, and honours a Wi-Fi-only toggle.
- Pack building (compression, WebP conversion) runs in a Node script or GitHub Action, never in an Edge Function.

## Consequences

A typo fix re-downloads only changed files. Packs are larger on disk than gzip bundles, in exchange for faster
opens on weak CPUs.
