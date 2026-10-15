# Database migrations

Git is the source of truth for the schema of the Supabase project **CUSTAR Tutor**
(`kjmjyxherydvefwtzmez`, eu-west-1, the DEV database until real families onboard). Every file here has
been applied to that project, and its file name carries the version the server assigned.

## Rules

- `public` is the only schema exposed to PostgREST. `private` holds `SECURITY DEFINER` helpers and RPC
  implementations and is never exposed (`supabase/config.toml` keeps `[api] schemas = ["public"]`).
- Every table has RLS enabled in the migration that creates it. `anon` has **no** privilege on anything.
  `authenticated` has only the grants its policies need (column-level where it matters).
- `SECURITY DEFINER` functions pin `search_path = ''`, qualify every object, and use
  `(select auth.uid())`. The exposed schema contains **no** `SECURITY DEFINER` function: each RPC is a
  thin `SECURITY INVOKER` wrapper `public.<name>` over `private.<name>`.
- One permissive policy per (table, command).
- Admin policies and RPCs go through `private.has_admin_role()`, which requires `aal2`.
- Children have no accounts. Child-data rows carry denormalised `household_id` and `child_id`.
- Append-only tables (`consents`, `audit_log`, `progress_events`) and `published_units` have
  `UPDATE`/`DELETE`/`TRUNCATE` revoked from every API role, `service_role` included.
- Server-derived tables (`unit_progress`) and the event log have **no client write path at all**: the only
  writer is `ingest_progress_events`.

## The migration set

| Version          | File                           | Contents                                                                                           |
| ---------------- | ------------------------------ | -------------------------------------------------------------------------------------------------- |
| `20261011225501` | `foundations`                  | `private` schema, deny-by-default privileges, `sync_seq_global`, `private.set_sync_seq()`          |
| `20261011225647` | `curriculum_tables`            | levels, subjects, schemes, scheme_weeks, themes, theme_units, characters, chapters, units, unit_versions, published_units |
| `20261011230334` | `identity_tables`              | profiles (+ signup trigger), admin_users, households, household_members, children, child_secrets, child_access, invites, grownup_pins, grownup_elevations |
| `20261011230509` | `consent_and_audit_tables`     | consents, audit_log                                                                                |
| `20261011230744` | `rls_helpers_and_policies`     | helper functions, guard triggers, all policies and grants, `member_display` view                   |
| `20261011231704` | `rpcs`                         | private implementations and public wrappers of every RPC                                           |
| `20261011231743` | `audit_triggers`               | audit triggers on household_members, child_access, admin_users, published_units, unit_versions     |
| `20261011231756` | `seed_reference_data`          | levels P1-P6, 8 core subjects + 4 electives, Zari and Zuri stubs                                   |
| `20261011234848` | `hardening_followups`          | guardian-invite TTL cap (72h), PIN lockout cap (1h), RPC comments                                  |
| `20261012042817` | `sync_cursor_and_epoch`        | serialised `sync_seq` (the cursor fix), `households.membership_epoch` + triggers, re-stamping of flattened units |
| `20261012042925` | `progress_tables`              | `progress_events` (append-only), `unit_progress`, `private.derive_unit_progress`                    |
| `20261012043223` | `ingest_progress_events`       | the only write path of progress: per-event validation, idempotency, rate limit, derivation         |
| `20261012043359` | `pack_publishing`              | pack columns on `published_units`, `get_pack_source` / `set_pack_info` / `authorize_pack_download`, private `packs` bucket |
| `20261012043551` | `sync_pull`                    | `sync_pull(p_since_seq, p_limit)`: one page of the learner pull (`wire.ts` `PullResponse`)          |
| `20261012060050` | `m2_ai_tables`                 | M2 content engine 1/7: `app_settings`, `ai_jobs`, `ai_usage` (RLS, column grants, audit trigger), `private.touch_updated_at` |
| `20261012060435` | `m2_ai_job_rpcs`               | M2 2/7: `create_ai_job`, `cancel_ai_job` (staff) and `ai_job_acquire_lease` / `ai_job_complete_step` / `ai_job_fail_step` / `ai_job_budget_check` (service_role only), settings and cost helpers |
| `20261012061029` | `m2_content_rpcs`              | M2 3/7: `save_scheme_draft`, `approve_scheme`, `apply_chapter_plan`, `create_unit_version_draft`, `set_unit_version_status`, `get_ai_settings`, `set_app_setting`, `get_ai_usage_summary` |
| `20261012061107` | `m2_scheme_uploads_bucket`     | M2 4/7: private `scheme-uploads` bucket (20 MiB, PDF / DOCX / text) and its two `storage.objects` policies |
| `20261012061127` | `m2_cast_facts`                | M2 5/7: the owner's facts about Zari and Zuri merged into `characters.traits`                       |
| `20261012062224` | `m2_usage_pricing`             | M2 6/7: prefix price lookup (`private.ai_price_for`, same rule as `priceFor` in the contract), usage logged by `ai_job_fail_step` too (new 6-arg signature), kill switch also refuses a new lease |
| `20261012062346` | `m2_fail_step_stub_rename`     | M2 7/7: the superseded 5-arg `ai_job_fail_step` pair renamed to `*_deprecated` (a 5-positional-argument call was ambiguous between the two overloads) |
| `20261012081415` | `m2_unit_layout`               | M2.4 1/2: `apply_unit_layout(p_scheme_id, p_layout, p_confirm_renumber)` (units added, removed and reordered by hand, 3 to 5 per chapter; the numbering decision is in the file header), `private.json_uuid`, `private.layout_unit_fields`, `private.unit_layout_result` |
| `20261012082805` | `m2_unit_layout_theme_links`   | M2.4 2/2: a unit that leaves a themed chapter loses its link to that chapter's theme (`create or replace` of `private.apply_unit_layout`) |

The 28 tables are: `profiles`, `admin_users`, `households`, `household_members`, `children`,
`child_secrets`, `child_access`, `invites`, `grownup_pins`, `grownup_elevations`, `consents`,
`audit_log`, `levels`, `subjects`, `schemes`, `scheme_weeks`, `themes`, `theme_units`, `characters`,
`chapters`, `units`, `unit_versions`, `published_units`, `progress_events`, `unit_progress`,
`app_settings`, `ai_jobs`, `ai_usage`; plus the view `member_display`.

## Workflow

1. Write `<UTC timestamp>_<name>.sql` here.
2. Apply it with the Supabase MCP `apply_migration` (name + SQL).
3. Run `list_migrations` and **rename the file to the version the server assigned** so git and the
   database cannot drift.
4. Run the pgTAP suite, `get_advisors` (security and performance), then regenerate the types (below).

Gotchas when applying through the MCP:

- A line that **starts** with `DROP` or `DELETE` (observed; `TRUNCATE` presumably too) is held back for
  human confirmation, and in an unattended session the call just times out after 60 s without touching
  the database. Avoid those statements at the start of a line (use `create or replace`, plain `create`,
  upserts and `update ... set` instead; the same applies to SQL passed to `execute_sql`, including
  test files). Check `list_migrations` after a timeout before retrying.
- `apply_migration` is atomic: a failed file leaves nothing behind.
- Policies and triggers are created with plain `create` (migrations run exactly once); functions use
  `create or replace`; seeds use `on conflict do nothing`.

## Access matrix (role `authenticated`; `anon` gets nothing)

| Table                                                  | Read                                                                 | Write                                                                                  |
| ------------------------------------------------------ | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `profiles`                                             | own row                                                              | own `display_name`                                                                     |
| `member_display` (view)                                | display names of the members you may see (guardian: all, tutor: guardians + self) | -                                                                         |
| `households`                                           | members                                                              | guardians rename; creation only via `create_household`                                 |
| `household_members`                                    | own row; guardians see all rows; tutors also see the guardians       | **none** (only `create_household`, `accept_invite`, `remove_member`)                   |
| `children`                                             | guardians of the household; tutors with an active grant              | guardians insert/update; changing `daily_limit_min` or `deleted_at` needs an elevation; no DELETE (tombstone) |
| `child_access`                                         | guardians of the household; a tutor sees own grants                  | **none** (RPCs only)                                                                   |
| `child_secrets`, `invites`, `grownup_pins`, `grownup_elevations` | **none** (RLS on, no policy, no grant)                     | **none** (RPCs only)                                                                   |
| `consents`                                             | own rows                                                             | INSERT own row as a guardian of the household (grant needs an elevation, withdraw does not); no UPDATE/DELETE |
| `audit_log`                                            | `super_admin` at aal2                                                | none (written by definer triggers/functions)                                           |
| `admin_users`                                          | own row; `super_admin` (aal2) sees all                               | `super_admin` at aal2                                                                  |
| `levels`, `subjects`                                   | everyone                                                             | `super_admin` (levels); `super_admin`, `content_editor` (subjects)                     |
| `characters`                                           | active rows: everyone; all rows: content staff                       | `super_admin`, `content_editor`                                                        |
| `schemes`, `scheme_weeks`, `themes`, `theme_units`     | content staff (`super_admin`, `content_editor`, `reviewer`) at aal2  | `super_admin`, `content_editor`; DELETE: `super_admin`                                 |
| `chapters`, `units`                                    | `status = 'published'`: everyone; everything: content staff          | `super_admin`, `content_editor`; `published` is reachable only through `publish_unit_version`; no DELETE |
| `unit_versions` (drafts, lint reports)                 | content staff at aal2 only                                           | INSERT: `super_admin`, `content_editor` (as `draft`); UPDATE also `reviewer`; no DELETE |
| `published_units`                                      | `is_current and deleted_at is null`: everyone; history: content staff | **none** (`publish_unit_version` only). Pack columns (`pack_manifest_path`, `content_hash`, `pack_built_at`) are set once, through `set_pack_info`; `min_app_version` is fixed at publish |
| `progress_events`                                      | `can_access_child(child_id)`: guardians of the household, tutors with a grant | **none** (`ingest_progress_events` only); append-only for every role                   |
| `unit_progress`                                        | `can_access_child(child_id)`                                         | **none** (derived by the server from the events)                                       |
| `households.membership_epoch` (column)                 | members (with the rest of the row)                                   | **none**: maintained by triggers, never written by a client                            |
| `app_settings`                                         | content staff (`super_admin`, `content_editor`, `reviewer`) at aal2   | **none** (`set_app_setting`, `super_admin` at aal2, validated by shape per key and audited). Nobody holds a table write privilege, `service_role` included |
| `ai_jobs`                                              | content staff at aal2, **own jobs only** (`super_admin` sees all), and only the columns `id, kind, status, progress, result, error, attempts, lease_until, unit_id, scheme_id, created_by, created_at, updated_at, finished_at`; `params`, `input`, `state`, `lease_token`, `idempotency_key` are granted to nobody | **none** (`create_ai_job`, `cancel_ai_job`, and the four service-role lease RPCs). `select *` is refused: name the columns |
| `ai_usage`                                             | **none** (RLS on, no policy, no grant); read the aggregates through `get_ai_usage_summary` | **none** (written by the lease RPCs, one row per model call)                |
| `storage.objects`, bucket `scheme-uploads`             | content staff at aal2, objects under their own `<user id>/` prefix only | INSERT under the own prefix by `super_admin` / `content_editor` at aal2; no UPDATE, no DELETE |

`support` and `analyst` have no policy on any household data, consent, draft or curriculum planning table.
`analyst` aggregate views (small-cell suppression) and time-boxed `support` access are not built yet.

## Helper functions (schema `private`)

All `SECURITY DEFINER STABLE`, `search_path = ''`, `EXECUTE` granted to `authenticated` only.

| Function                                  | Meaning                                                                                      |
| ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| `is_household_member(hid, roles[])`       | caller is an active member of the household with one of the roles                            |
| `is_granted_tutor(child_id)`              | caller is an active tutor with an active (non-revoked) grant for the child                   |
| `can_access_child(child_id)`              | guardian of the child's household, or a granted tutor. **Use this on every future child-data table** (progress, sessions, ...). It does not exclude soft-deleted children. |
| `has_admin_role(roles[])`                 | caller has one of the roles in `admin_users` **and** `auth.jwt() ->> 'aal' = 'aal2'`           |
| `has_grownup_elevation()`                 | caller holds an unexpired elevation (any device in M0; `TODO(device binding)` in the source) |
| `member_display_name(hid, uid)`           | backs `member_display`                                                                       |
| `chapter_unit_count_ok(chapter_id)`       | 3 to 5 live units; used by `publish_unit_version` (no `authenticated` grant)                 |

Guard triggers (invoker context; the owner, `service_role` and `supabase_admin` pass through):
`children` (immutable ids; elevation for `daily_limit_min`/`deleted_at`), `unit_versions` (new rows
start `draft`; only `reviewer`/`super_admin` approve; approved content frozen; published/superseded
immutable; provenance immutable), `chapters`/`units` (no direct `published`), `published_units`
(immutable snapshot for **every** role including the owner; only `is_current`/`deleted_at`/`sync_seq`
change; DELETE refused).

## RPCs (all `public.*`, callable by `authenticated` only)

Parameters are prefixed `p_`. Failures raise a stable message (see `DbErrorMessage` in
`packages/supabase/src/index.ts`).

| RPC                                                    | Who may call                                  | Notes                                                                                                   |
| ------------------------------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `create_household(p_name)` -> uuid                     | any signed-in user                            | creates the household and the caller's guardian membership; max 5 per user                              |
| `create_invite(p_household_id, p_role, p_child_ids, p_ttl_hours=72)` -> `{invite_id, token, expires_at}` | guardian **+ elevation** | raw token returned **once**, only its sha256 is stored. Guardian invites: max 72h, no children. Tutor invites: max 168h, 1-20 children of the household. Max 20 pending per household |
| `accept_invite(p_token)` -> `{household_id, role}`     | any signed-in user holding a valid token      | single-use (row lock), expiring; the inviter must still be an active guardian; the only join path besides `create_household` |
| `remove_member(p_household_id, p_user_id)`             | guardian **+ elevation**                      | tombstones the membership and the member's grants; the last guardian cannot be removed                  |
| `grant_child_access(p_child_id, p_tutor_user_id)` -> uuid | guardian **+ elevation**                   | an existing tutor of the household; returns NULL when already granted                                   |
| `revoke_child_access(p_child_id, p_tutor_user_id)` -> int | guardian **+ elevation**                   | tombstones the active grant; returns how many were revoked                                              |
| `set_grownup_pin(p_pin)`                               | any signed-in user                            | 4-6 digits, bcrypt cost 10, weak PINs refused. First PIN needs no elevation; changing needs one        |
| `elevate_grownup(p_device_id, p_pin)` -> timestamptz   | any signed-in user with a PIN                 | NULL on a wrong PIN or while locked (does not raise, so the counter persists); success -> 10 min elevation. 5 failures lock for 30s, doubling, capped at 1h |
| `end_grownup_elevation()`                              | any signed-in user                            | back to child mode immediately                                                                          |
| `get_grownup_pin_status()` -> `{has_pin, locked_until, failed_attempts}` | any signed-in user          | own state only (`locked_until` is null when not locked)                                                 |
| `publish_unit_version(p_unit_version_id)` -> uuid      | `super_admin`, `content_editor`, `reviewer` at **aal2** | needs an `approved` version, a chapter of 3-5 units, a version newer than the current snapshot. Idempotent |
| `ingest_progress_events(p_events)` -> jsonb[]          | any signed-in user; **each event** is authorised on its own | up to 100 events per call (`batch_too_large` above that; `invalid_events` if not an array). Returns one `{client_event_id, status, reason?}` per input event, in input order: `accepted`, `duplicate` (same `(child_id, client_event_id)`, first write wins) or `rejected` with `invalid_payload`, `no_access_to_child` (also for a child that does not exist), `child_deleted`, `unknown_unit`, `inconsistent_mastery` (`passed` must equal `score >= 0.8 and question_count > 0`), `rate_limited` (2000 events per child per hour), `internal_error`. A poison row never blocks its neighbours. The household is looked up from the child; a client-sent one is ignored; unknown payload keys are dropped; `occurred_at` must be an ISO instant with a zone in 2020..2100 |
| `sync_pull(p_since_seq, p_limit)` -> `PullResponse`    | any signed-in user                            | the shape of `wire.ts`. Scope is the caller's earliest active guardian household (none: epoch 0, household null, only global rows). Limit clamped to 1..500. `invalid_cursor` for a negative or null cursor |
| `authorize_pack_download(p_unit_id, p_version_no)` -> `{manifest_path, content_hash}` | any active household member (guardian or tutor) | the version must **serve** (below). Called by `get-pack-download` with the caller's JWT; it signs nothing itself. `not_a_household_member`, `pack_not_found` |
| `get_pack_source(p_published_unit_id)` -> jsonb        | `super_admin`, `content_editor`, `reviewer` at **aal2** | the snapshot content and its pack state, for `publish-pack`                                             |
| `set_pack_info(p_published_unit_id, p_manifest_path, p_content_hash)` | same admins at **aal2**, or `service_role` (a CI pack job) | **write-once**: the same values again are a no-op (`already_set: true`), different values raise `pack_info_already_set`. The path must be `units/<unit_id>/<version_no>/manifest.json`, the hash 64 lower-case hex |

Content engine (M2) RPCs. Admin roles need **aal2** everywhere; failures are stable snake_case messages
(`DbErrorMessage`), SQLSTATE `42501` for permission, `P0002` not found, `22023` invalid, `53400` limit.

| RPC                                                    | Who may call                                  | Notes                                                                                                   |
| ------------------------------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `create_ai_job(p_kind, p_params, p_input, p_unit_id, p_scheme_id, p_idempotency_key)` -> JobRow | `super_admin`, `content_editor` | the `ai-job` function resolves the engine input with the caller's JWT and stores it here (hidden from clients). Idempotent per (creator, key); `idempotency_key_reused` for another kind; `kill_switch` (42501); `too_many_jobs` (53400) at 5 unfinished jobs per creator. A reviewer cannot create jobs: every job ends in a write only editors may do |
| `cancel_ai_job(p_job_id)` -> JobRow                    | the creator, or `super_admin`; any content staff may call but see only what they may see | a finished job is returned unchanged; another person's job is `job_not_found`. A step in flight loses its output (the lease is dropped) but its spend is still logged |
| `save_scheme_draft(p_subject_id, p_level_code, p_term, p_weeks, p_source_note)` -> uuid | `super_admin`, `content_editor` | replaces the weeks of the DRAFT scheme of (subject, level, term) or creates it; a scheme that is not a draft is never rewritten (`scheme_not_draft`). Weeks are validated like `Scheme` in content-schema |
| `approve_scheme(p_scheme_id)`                          | `super_admin`, `reviewer`                     | draft -> approved; needs a teaching week; approving an approved scheme is a no-op; audited               |
| `apply_chapter_plan(p_scheme_id, p_plan)` -> counts    | `super_admin`, `content_editor`               | needs an APPROVED scheme. Creates / updates draft chapters and units (3 to 5 per chapter, weeks must exist), links the theme, idempotent (an unchanged plan writes nothing), atomic; a unit that has a version is never changed or dropped (`unit_has_versions`); a chapter that is no longer a draft keeps its title (`chapter_not_draft`) |
| `apply_unit_layout(p_scheme_id, p_layout, p_confirm_renumber default false)` -> `{chapters, units, units_created, units_updated, units_moved, units_renumbered, units_archived, chapters_created, created_unit_ids, created_chapter_ids, layout}` | `super_admin`, `content_editor` | one atomic call that sets the chapter, order and term-wide number of EVERY live unit of an APPROVED scheme. The layout must name every live chapter and unit once (`layout_out_of_date` for a stale page, `unit_not_in_scheme`, `chapter_not_in_scheme`, `chapter_order_changed`, `duplicate_unit_in_layout`); 3 to 5 units per chapter (`chapter_unit_count_invalid`). Adds units (and chapters after the existing ones), archives the units in `removed` (they must have no version; the row stays, tombstoned, number parked at 10000+n). A unit with versions is never edited or removed (`unit_has_versions`), cannot leave its chapter once published (`published_unit_cannot_move`) and is renumbered or moved only with `p_confirm_renumber` (`layout_renumbers_versioned_units`, error DETAIL = JSON list `[{id, title, from, to}]`). Idempotent: an unchanged layout writes nothing (no `sync_seq`, no audit row). Locks the scheme row `FOR UPDATE` (serialises with `apply_chapter_plan`), writes in id order. Audited as `unit_layout_applied` |
| `create_unit_version_draft(p_unit_id, p_content, p_lint_report, p_generated_by, p_model, p_prompt_version, p_base_version_id)` -> `{id, version}` | `super_admin`, `content_editor` | the only way the function saves an AI draft: numbered under a row lock, always a `draft`, `stale_base` unless the base is the latest version (or null for a first one). `SECURITY INVOKER`, so RLS and the `unit_versions` guard trigger stay the last line of defence |
| `set_unit_version_status(p_unit_version_id, p_status)` | staff; see notes                              | draft -> in_review (any staff), in_review -> approved or back to draft (`reviewer`, `super_admin` only); every other move is `illegal_status_move`. `SECURITY INVOKER`: publishing stays `publish_unit_version` |
| `get_ai_settings()` -> `AiSettings`                    | content staff                                 | stored keys laid over the defaults (`DEFAULT_AI_SETTINGS`), so an empty table is a working configuration |
| `set_app_setting(p_key, p_value)`                      | `super_admin`                                 | known keys only (`ai.models`, `ai.kill_switch`, `ai.budget`, `ai.prices`, `ai.effort`, `ai.prompt_version`); the value is validated by shape; only a real change is audited |
| `get_ai_usage_summary(p_from, p_to)` -> `{totals, by_day, by_model, by_kind}` | `super_admin`, `content_editor`, `analyst` | window of at most 366 days (`invalid_range`); costs sum only KNOWN prices and unpriced calls are counted separately: unknown is never shown as zero |
| `ai_job_acquire_lease(p_job_id, p_lease_seconds)`      | **`service_role` only**                       | `{acquired, reason busy \| terminal, job, kind, input, state, lease_token}`. A live lease is `busy`; an expired lease is taken over and counts as one failed attempt (`aborted`), the third ends the job; refused with `kill_switch` while the switch is on |
| `ai_job_complete_step(p_job_id, p_lease_token, p_step, p_output, p_usage, p_progress, p_result)` -> boolean | **`service_role` only** | stores the output only while the token still holds the lease (false otherwise, so a late finisher cannot overwrite a newer attempt); the usage is logged either way; a `p_result` finishes the job |
| `ai_job_fail_step(p_job_id, p_lease_token, p_step, p_error, p_retryable, p_usage default '[]')` -> boolean | **`service_role` only** | records `{code, message<=500, step, retryable}` only (no raw output, no stack); 3 failed attempts or a non-retryable error end the job; the billed calls of the failed step go to `ai_usage` |
| `ai_job_budget_check(p_job_id)`                        | **`service_role` only**                       | `{kill_switch, job_cost_usd, day_cost_usd, max_usd_per_job, daily_usd_cap, unpriced_calls, day_unpriced_calls}` |

Cost rule: `ai.prices` maps a model id (or a prefix of it) to USD per million tokens. A call is priced by
the exact id, else by the LONGEST key that is a prefix of the reported id, so the alias `claude-opus-5-5`
prices the snapshot `claude-opus-5-5-20261001`. No match is `NULL` (unpriced), never zero. This is
`priceFor` of `packages/authoring-core/src/contract.ts`; pgTAP `080` checks the two agree on the cases.

Elevation-gated actions: invite creation, member removal, grant/revoke of tutor access, PIN change,
granting consent, changing a child's daily limit, deleting/restoring a child.

## Sync contract

Syncable tables: `children`, `household_members`, `child_access`, `levels`, `subjects`, `chapters`,
`units`, `published_units`, `unit_progress`. Each has `sync_seq bigint not null` (stamped from
`public.sync_seq_global` by `private.set_sync_seq()` on every INSERT and UPDATE, indexed) and `deleted_at`
(on `unit_progress` the column exists for the wire shape; nothing sets it today, and `sync_pull` only
sends the progress of live children).

- **The client cursor is `sync_seq`, never `updated_at`.**
- Removal is a **tombstone** (`deleted_at` set, row kept and still selectable by whoever could see the
  live row), never a hard delete. Revoked grants carry both `revoked_at` and `deleted_at`.
- **Cursor ordering is solved on the server, so clients pull with NO overlap.** A sequence value is drawn
  when a row is written but becomes visible only at COMMIT, so a naive scan can skip a row for good
  (transaction A draws 41, B draws 42 and commits first, the reader stores 42 and never sees 41).
  `set_sync_seq()` therefore takes one global transaction-level advisory lock
  (`private.sync_lock()`, key `1543551832891593539`) **before** `nextval`, and holds it until commit or
  rollback. Stamping writers run one after the other, so draw order = commit order = visibility order,
  and `sync_pull` is `STABLE` (all its statements share one snapshot), so a page can never contain
  `sync_seq` N+1 without N. Aborted transactions only leave gaps. Cost: stamping transactions are
  serialised until commit (tiny write volume here; keep them short, never hold one open across a network
  call). Known limit: two transactions that stamp rows in opposite orders while holding row locks on each
  other's rows can deadlock; Postgres aborts one with `40P01` and the caller retries. The RPCs avoid it by
  doing their non-stamping work first and stamping in a sorted order (see `ingest_progress_events`).
- **Membership epoch.** `households.membership_epoch` takes a new value from `membership_epoch_seq`
  (never "+1", so two households can never report the same value) whenever access to the household
  changes: a member added, removed, re-roled or restored, a tutor grant given or revoked, a child
  deleted or restored. The client wipes its household data and re-pulls from cursor 0 when the epoch it
  receives differs from the stored one. Epoch 0 means "no household".
- **Units are flattened and appear with their pack.** `sync_pull` sends a unit (with its chapter and
  scheme fields) only when it has, or once had, a built pack. Triggers on `chapters`, `schemes` and
  `published_units` re-stamp the unit row, so it re-syncs whenever one of its inputs changes.
- **A pack row *serves* (`private.pack_is_serving`)** when it has pack info, is not tombstoned, is the
  highest such version of its unit, and the unit still has a current, non-tombstoned snapshot. The newest
  published version starts serving only once ITS pack is built: between `publish_unit_version` and
  `publish-pack` the previous built version stays on offer, so there is never a window without a
  downloadable pack. `set_pack_info` re-stamps the older built versions so their tombstones reach the
  devices. Rows that do not serve are emitted as tombstones; inactive subjects are tombstones too.
- `published_units` is visible to clients through `published_units` only while
  `is_current and deleted_at is null`. Unpublishing needs its own RPC (not built).

## Packs and edge functions

Lesson packs (ADR 0004) live in the **private** storage bucket `packs` (50 MiB per object; JSON, webp,
png, jpeg and audio MIME types). There is **no policy on `storage.objects`**: nothing but the service role
used by the two edge functions can read or write it. Layout:
`units/<unit_id>/<version_no>/{manifest,learner,grownup}.json` and `blobs/<sha256>` (media, shared by
content hash). The learner pack never contains `teacher_manual` (it is in the grown-up pack).
`published_units.content_hash` is the sha256 of `JSON.stringify(<parsed unit>)`, identical to
`buildPackFiles` in `packages/learner-core/src/fakes/pack-builder.ts` (a Vitest test proves the output
for `goldenUnit2` is byte-identical for the same input). The bytes depend on the key order of the input
(maps such as `questions` keep it) and Postgres `jsonb` normalises key order, so a pack built on the
server from `published_units.content` can differ in bytes, hence in hash, from one built in the app from
the TypeScript fixture. That is harmless: the manifest and `content_hash` always describe the bytes the
server stored, and devices verify those; for one snapshot the output is always the same.

| Function (`supabase/functions/`) | Caller                                        | What it does                                                                                       |
| -------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `get-pack-download`              | any signed-in household member or granted tutor | `POST {p_unit_id, p_version_no}` -> `PackDownload {manifest, urls, expires_at}` (`wire.ts`). Authorised by `authorize_pack_download` with the **caller's JWT**; only then the service role reads the authorised manifest from storage and signs URLs (2 hours, Range supported) for the files that manifest lists. Storage paths are derived from the validated ids and hashes, never copied from the manifest text; a manifest that disagrees with the database is a 500 `pack_corrupt` |
| `publish-pack`                   | `super_admin`, `content_editor`, `reviewer` at aal2 | `POST {published_unit_id}`: `get_pack_source` (caller's JWT) -> build the pack -> upload with the service role (manifest last) -> `set_pack_info` (caller's JWT). Idempotent: a snapshot whose pack is built returns `already_built: true` and touches nothing; a crashed run is re-run (uploads overwrite identical bytes). 409 `not_current` for a superseded or tombstoned snapshot, 422 `content_not_packable` for content that does not parse |

`ai-job` (the content engine, below) is a third function with the same conventions.

Both pack functions have `verify_jwt = true` in `supabase/config.toml`, accept `POST` only, and return
`{error: {code, message}}` with stable snake_case codes (database messages pass through; anything else is
a bare 500 `internal_error`, the detail only in the logs). The service role is created in
`_shared/clients.ts` and is used for storage only, after the database has said yes.

Shared code is in `supabase/functions/_shared/` (pure logic, unit tested with Vitest:
`npx vitest run supabase/functions`; only `clients.ts` and the two `index.ts` need Deno). The content
schema comes from `_shared/vendor/content-schema.js`, a bundle of `packages/content-schema` (zod inline,
about 830 KB).

Deploying: `supabase functions deploy get-pack-download publish-pack` is the repo standard. The Supabase
MCP `deploy_edge_function` cannot carry the 830 KB vendor bundle, so the dev project was deployed with a
**trimmed** vendor (esbuild with `--external:zod`, the `zod` import rewritten to `npm:zod@4.6.6`;
byte-for-byte the same results on the golden unit). Redeploy with the CLI before real use so the deployed
code is the committed code.

## The content engine (M2): `ai-job`

ADR 0007: client-driven stepping. The admin app calls `ai-job` with `{action: 'create' | 'step' | 'cancel'}`
(`AiJobRequest` in `packages/authoring-core/src/contract.ts`); one `step` request runs ONE engine step.

| Piece                                                       | Role                                                                                       |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `supabase/functions/ai-job/index.ts`                        | Deno glue: `Deno.serve`, `EdgeRuntime.waitUntil`, the Anthropic SDK (pinned 0.133.0), the two Supabase clients, `_shared/vendor/authoring-core.js` |
| `_shared/ai-job-handler.ts`                                 | the whole protocol as a pure function `handleAiJob(req, deps)`: CORS, auth, validation, create, step, cancel, failure accounting |
| `_shared/ai-job-context.ts`                                 | turns ids into the engine input by reading with the **caller's JWT** (RLS applies to every read) |
| `_shared/ai-job-errors.ts`, `ai-job-types.ts`               | error codes -> HTTP statuses, database error mapping, structural types of the contract       |
| `_shared/ai-job-{fake-db,test-kit}.ts`, `*.test.ts`          | in-memory Supabase client and job backend (mirrors the SQL), 123 Vitest tests in `_shared` (91 for `ai-job`) |

How a step goes: authenticate (JWT claims, `aal2`, `admin_users` role; the gateway verifies the signature,
the database re-checks everything) -> load the job with the caller's client (RLS) -> only the creator
steps -> finished jobs answer 200 as they are -> `ANTHROPIC_API_KEY` present (else 500, no lease taken) ->
`get_ai_settings` -> kill switch (503) -> a live lease answers `{busy: true}` -> `ai_job_budget_check`
(per-job and daily caps, 429 `budget_exceeded`) -> `ai_job_acquire_lease` (service role) -> **202** and the
step runs in `waitUntil` -> the output is stored by `ai_job_complete_step`; for unit jobs the draft is
first saved with `create_unit_version_draft` using the **caller's JWT** (`generated_by = 'ai'`,
`stale_base` is a non-retryable conflict). The service role is used for the four `ai_job_*` RPCs and
nothing else. A failure stores a fixed, safe message (never the engine's text, raw model output, a key or
a stack trace); the billed calls of a failed step are logged too.

Secrets (Supabase dashboard -> Edge Functions -> Secrets, or `supabase secrets set`; never in the repo):
`ANTHROPIC_API_KEY` and `ALLOWED_ORIGINS` (comma-separated admin app origins; `http://localhost:<port>` and
`http://127.0.0.1:<port>` are always allowed for development; the origin is reflected, never `*`).

Deploy from the repo with the CLI (the bundle is about 1 MB, too big for the MCP deploy tool):

```sh
node scripts/vendor-authoring.mjs && supabase functions deploy ai-job
```

`verify_jwt = true` is set in `supabase/config.toml`. The function has **not** been deployed or called
against the real project from the build environment (egress to `*.supabase.co` is blocked there); the
database half is tested live (pgTAP 080 to 082) and the handler by Vitest, including an integration test that
runs the real step engine with the demo model through the handler for `chapter_plan`, `unit_generate` and
`unit_revise`, once with the engine source and once with the Deno bundle.

## Seed: the golden unit

`node scripts/generate-seed.mjs` writes `supabase/seed/golden_unit2.sql` (`--check` fails when it is
stale): Basic Science P1 Term 1, Chapter 1 "Our World Around Us" with units 1-4, and an **approved**
version of Unit 2 (the golden fixture). Fixed UUIDs, idempotent. It does not publish; publishing is an
admin action (`select public.publish_unit_version('0b5c0004-0000-4000-8000-000000000002')` as an admin
at aal2), then `publish-pack` builds the pack. The dev project has this seed applied and the snapshot
published (`published_units.id = 31f5546d-79dd-475e-bd8b-402d3f38a835`, pack not built yet). The seed
publish left 6 rows in `audit_log` (the temporary admin that signed it was deleted again).

## Tests (pgTAP)

`supabase/tests/database/*.test.sql`, each file `begin; ... select * from finish(); rollback;`:

| File                                   | Tests | Covers                                                                                              |
| -------------------------------------- | ----: | --------------------------------------------------------------------------------------------------- |
| `000_hardening.test.sql`               |    32 | RLS everywhere, anon has nothing, function ACL whitelist, definer hygiene, append-only, seed data   |
| `010_households_children.test.sql`     |    47 | household isolation, no self-join, tutor scope, profiles/`member_display`, parental-control guard   |
| `020_invites_tutors.test.sql`          |    51 | invite hash/single-use/expiry/elevation, grant, revoke, removal, re-invite                          |
| `030_grownup_pin.test.sql`             |    51 | PIN never readable, bcrypt, back-off, lockout, elevation lifecycle, audit                           |
| `040_consents_audit_admin.test.sql`    |    40 | consents append-only, audit visibility, admin_users, support/analyst boundary                       |
| `050_curriculum_publish.test.sql`      |    64 | draft visibility (non-admin, aal1), review workflow, publish gate, pointer flip, immutability       |
| `060_sync.test.sql`                    |    13 | `sync_seq`, tombstones, indexes                                                                     |
| `070_progress_ingest.test.sql`         |    57 | ingest: validation per event, poison rows, idempotency, authorisation, rate limit, derivation (idempotent, commutative, mastery never regresses), append-only, read isolation |
| `071_membership_epoch.test.sql`        |    27 | the epoch changes on every access change and only then; distinct across households                  |
| `072_sync_pull.test.sql`               |    52 | `sync_pull`: wire shape, scope, paging, tombstones, flattened units, serving rule, cursor safety     |
| `073_pack_publishing.test.sql`         |    55 | pack columns and constraints, write-once `set_pack_info`, who may call what, `authorize_pack_download`, bucket |
| `080_ai_jobs.test.sql`                 |   161 | `app_settings` / `ai_jobs` / `ai_usage` access and column grants, `create_ai_job` (roles, aal2, idempotency, kill switch, limit of 5), `cancel_ai_job`, the lease RPCs (busy, takeover, late finisher, 3 attempts, scrubbed errors), costs (prefix price lookup), budget check, failed-but-billed usage |
| `081_ai_content_rpcs.test.sql`         |   159 | `save_scheme_draft`, `approve_scheme`, `apply_chapter_plan` (validation, idempotency, atomic refusal, units with versions), `create_unit_version_draft` (`stale_base`, provenance, guard trigger), `set_unit_version_status` |
| `082_ai_settings_usage_storage_cast.test.sql` | 116 | `get_ai_settings` / `set_app_setting` (shape validation per key, audit), `get_ai_usage_summary`, the `scheme-uploads` bucket policies (conditional: skipped with a note when the storage service has not created the bucket or policies), the owner's cast facts |
| `120_unit_layout.test.sql`             |   141 | `apply_unit_layout`: access (anon, plain, reviewer, support, analyst, aal1), malformed layouts, stale pages, idempotency (no `sync_seq`, no audit row), the scheme row lock, 3 to 5 at both ends, renumber confirmation and its DETAIL, reorder and move, published and versioned units, archival and the freed slot, new chapters, atomicity (a failing trigger), a colleague's concurrent change, `apply_chapter_plan` and `publish_unit_version` next to it, function hygiene |

All 14 files pass (925 tests; the 489 of M0 and M1 are unchanged apart from `000`, below). M2.4 adds `120` (141 tests, all green on the dev database); `000` (32), `050` (64), `081` (159) and `082` (116) were re-run live after it and pass.

`000_hardening` was extended, not weakened: its two function-ACL tripwires now list the M2 functions on
purpose, and its "Zari and Zuri are stubs with empty traits" assertion became "they carry only the
owner's facts (age, gender, pronouns, empty personality, empty voice, no relationship)", because
`m2_cast_facts` writes exactly those into `traits`.

CI (`.github/workflows/ci.yml`, job `database`): `supabase start` then `supabase test db`. Each file
creates pgTAP itself (`create extension if not exists pgtap with schema extensions`) inside its
transaction, so pgTAP is never installed on the real database. Inside a test, `now()` is frozen: lock
windows are asserted as exact offsets and "time passing" is simulated by moving `locked_until` /
`expires_at` into the past as the owner. Impersonate with
`set local role authenticated; set local request.jwt.claims = '{"sub":"<uuid>","role":"authenticated","aal":"aal1"}';`.

Ad hoc against the live dev database (MCP `execute_sql`, whole file as one query): the tool returns only
the **last** result set, and pgTAP 1.3 keeps no per-test table, so wrap the file like this and read the
summary row. The prelude shadows `add_result` in a throwaway schema (the extension's own functions are
not owned by `postgres`) and everything rolls back:

```sql
begin;
create extension if not exists pgtap with schema extensions;
create schema tap_shadow;  grant usage on schema tap_shadow to public;
create temp table tap_log (numb int, ok bool, descr text);  grant all on tap_log to public;
create function tap_shadow.add_result(boolean, boolean, text, text, text) returns integer language plpgsql as $f$
declare n integer;
begin
  if not $1 then perform _set('failed', _get('failed') + 1); end if;
  n := nextval('__tresults___numb_seq');
  insert into pg_temp.tap_log values (n, $1, $3);
  return n;
end $f$;
set local search_path = tap_shadow, "$user", public, extensions;
-- ... the test file body: select plan(N); ... (without begin / finish / rollback) ...
select (select value from __tcache__ where label = 'plan') as planned, count(*) as ran,
       count(*) filter (where not ok) as failed,
       string_agg(numb || ' ' || descr, ' | ' order by numb) filter (where not ok) as failures
  from tap_log;
rollback;
```

**The dev database is seeded** (the golden unit above), but tests 040, 050, 060, 070 and 072 assume an empty
curriculum and audit trail. Against the dev database, add this right after the `set local search_path`
line of the prelude; it hides the seed for the duration of the transaction and is rolled back with it
(a line must not start with `delete`/`drop`, hence the CTEs):

```sql
alter table public.published_units disable trigger published_units_protect;
alter table public.published_units disable trigger published_units_audit;
with d as (delete from public.published_units returning 1) select count(*) from d;
with d as (delete from public.unit_versions returning 1) select count(*) from d;
with d as (delete from public.units returning 1) select count(*) from d;
with d as (delete from public.chapters returning 1) select count(*) from d;
with d as (delete from public.schemes returning 1) select count(*) from d;
with d as (delete from public.audit_log returning 1) select count(*) from d;
alter table public.published_units enable trigger published_units_protect;
alter table public.published_units enable trigger published_units_audit;
```

On a fresh local stack (`supabase start`, no seed) nothing of this is needed.

## Types

`packages/supabase/src/database.types.ts` is generated; regenerate after **every** migration and commit:

```sh
supabase gen types typescript --local | npx prettier --stdin-filepath packages/supabase/src/database.types.ts > packages/supabase/src/database.types.ts
```

(or the MCP `generate_typescript_types`, then `prettier --write` the file: the repo's `format:check` would
otherwise fail on the generator's quote and semicolon style). The M1 additions (progress tables, pack
columns, epoch, the five new RPCs) were written into the file by hand in the generator's shape and
checked against `information_schema`; regenerate with the CLI once to confirm there is no diff. Hand-written domain unions
(`LevelCode`, `UnitVersionStatus`, ...) and `DbErrorMessage` live in `packages/supabase/src/index.ts`
and must be kept in step with the CHECK constraints and RPC messages by hand.

## Advisors (Supabase `get_advisors`)

Last run after the M2 server work (the seven `m2_*` migrations): **no ERROR or WARN, security or
performance.** Re-run after the two M2.4 migrations: the same, and no new finding of any level (the INFO list is only the
secret-holding tables and unused indexes listed below, plus the M3 tables). The M1 tables (`progress_events`, `unit_progress`), the private `packs` and `scheme-uploads`
buckets and the M2 tables raise nothing but INFO.

Deliberately accepted (INFO only):

- **`rls_enabled_no_policy` x5** on `child_secrets`, `invites`, `grownup_pins`, `grownup_elevations` and
  `ai_usage` (nobody reads usage rows directly: `get_ai_usage_summary` is the read path).
  This is the design: these tables hold secrets (picture-passcode hash, invite token hashes, PIN
  hash and lockout state, elevations). RLS is on, no policy exists and no privilege is granted to any
  client role, so they can only be reached through `SECURITY DEFINER` code. Adding a `using (false)`
  policy would only silence the lint.
- **`unused_index`** on a fresh database. Every foreign key and every sync cursor is indexed on purpose
  (the unit tests already use some of them); revisit with production traffic, not before.

Not an advisory but worth knowing: `private` has `USAGE` for `authenticated` (policies and wrappers
resolve `private.*` functions as the caller) and is not in the PostgREST `db-schemas`. Keep it that way.

## Open concerns and follow-ups for the lead

- **PIN bootstrap and recovery.** Until a PIN exists, whoever holds the session can set the first one;
  onboarding must set it before handing over the phone. There is no PIN reset flow yet (needs a recent
  email-OTP re-authentication check). A child can deliberately lock the PIN for up to 1 hour.
- **Elevation is not device-bound.** `grownup_elevations.device_id` is recorded but any device of the
  same user benefits. Bind it to the JWT `session_id` claim (`TODO(device binding)` in
  `private.has_grownup_elevation`).
- **Spec deviations chosen for safety:** tutors see only their own membership row and the guardians (not
  other tutors); granting consent, changing a child's daily limit and deleting a child need an
  elevation; guardian invites expire after at most 72h; invites die if the inviting guardian is removed;
  added RPCs `grant_child_access`, `revoke_child_access`, `end_grownup_elevation`,
  `get_grownup_pin_status` (tests need a revoke path and the UI needs the lock state).
- **No invite listing/cancel RPC** (the table has no client SELECT by design).
- **`child_secrets` has no RPC yet** (set/verify the picture passcode); `entitlements` (plan section 3) is
  not created.
- **Consent gate.** `consents` is readable only by its author; the tutor-chat gate (latest grant/withdraw
  per household, child and scope) needs a definer helper or service-role read in M3.
- **Erasure vs append-only.** Deleting an `auth.users` row cascades to the user's consents, PIN and
  memberships (erasure wins in M0); the retention/deletion design from plan section 8 is still to do.
- **Unpublish / archive.** A published chapter or unit cannot leave `published` through the API; an
  unpublish RPC (tombstoning the snapshot and its sync delivery) is not built.
- **Publish gate is not lint-aware.** `publish_unit_version` checks status, content shape, chapter size
  and ordering; the lint report (errors block publish) is enforced by the admin app / edge function
  until the report format is frozen. Four-eyes (creator != approver) is not enforced.
- **Membership epoch** is implemented (above). A user who is a guardian of several households syncs
  only the earliest one (`sync_pull` has one household in its wire shape); a household switcher needs a
  parameter on `sync_pull`.
- **Cursor lock and deadlocks.** Stamping transactions are serialised by one advisory lock. Keep them
  short, and stamp in a consistent order inside a transaction; a `40P01` from two opposite-order stampers
  must be retried by the caller (a failed push or pull is retried whole: both are idempotent).
- **Pack access is "any household member".** `authorize_pack_download` lets any active guardian or tutor
  fetch any built pack (the curriculum is already readable by every signed-in user). Tighten it with
  `entitlements` (plan section 3) when those exist.
- **`set_pack_info` may be called by `service_role`** (for a CI pack job), and by admins. It is write-once
  and the path is canonical, so it can switch on a pack whose bytes do not exist in storage if called
  with a made-up hash: only `publish-pack` (which uploads first) should call it.
- **Edge functions on the dev project run the trimmed vendor bundle**, and could not be called
  end-to-end from the build environment (egress to `*.supabase.co` is blocked there). Smoke test after
  redeploying with the CLI: publish the golden unit with an aal2 admin, then download it as a member.
- **Seed audit rows.** Publishing the golden unit on dev left 6 `audit_log` rows from the one-off admin
  that signed it.
- **First `super_admin`** must be inserted by hand (`insert into public.admin_users`, as the owner);
  TOTP enrolment is a Supabase Auth setting, not a schema feature.

### M2 content engine: follow-ups and decisions

- **M2.4, the unit layout (`apply_unit_layout`).** The numbering decision and its trade-offs are in the header of
  `20261012081415_m2_unit_layout.sql` and in `docs/m2-plan.md`: `units.unit_no` is the dense, term-wide ordinal; a unit
  with versions renumbers only with `p_confirm_renumber`; removal archives (status `archived`, tombstone, number
  parked above 10000), so `chapter_unit_count_ok` and the learner views ignore archived units and
  `create_unit_version_draft` refuses them (`unit_not_editable`). `apply_chapter_plan` is unchanged and still
  hard-deletes version-less units a new plan does not contain: re-planning after hand edits discards them (the planner
  warns). The second migration only adds the theme-link clean-up for a unit that changes chapter.
- **A pgTAP detail worth knowing:** `lives_ok` runs its statement in a sub-transaction, so a row locked by an RPC inside
  it shows the sub-transaction's id in `xmax`, not the test's own `pg_current_xact_id()`. `120` therefore asserts
  "`xmax` was 0 before and is not 0 after", with the probe rows inserted under `session_replication_role = replica`
  (a foreign-key insert would itself take a `FOR KEY SHARE` lock and hide the answer).

- **The deprecated `ai_job_fail_step` pair is still in the database.** `m2_usage_pricing` replaced the
  5-argument `ai_job_fail_step` by a 6-argument one (`p_usage jsonb default '[]'`); the old pair could not
  be dropped through the MCP (a line starting with `drop` is held back for human confirmation, and the
  call times out). It is revoked from everybody and renamed `ai_job_fail_step_deprecated`
  (`m2_fail_step_stub_rename`), so nothing can call it by accident. It is visible in the generated types.
  Remove both by hand, as the owner, in the SQL editor, then regenerate the types:

  ```sql
  drop function public.ai_job_fail_step_deprecated(uuid, uuid, text, jsonb, boolean);
  drop function private.ai_job_fail_step_deprecated(uuid, uuid, text, jsonb, boolean);
  ```

- **`ai-job` has never run against the real project.** Not deployed, not called (egress blocked in the
  build environment). Before the first use: set `ANTHROPIC_API_KEY` and `ALLOWED_ORIGINS` as function
  secrets, run `node scripts/vendor-authoring.mjs`, `supabase functions deploy ai-job`, then smoke test with
  an aal2 `content_editor`: create a `chapter_plan` job on an approved scheme and step it to the end.
  The Deno glue (`ai-job/index.ts`) is type-checked against stubs and the vendored bundle was exercised
  from Node, but `Deno.serve`, `EdgeRuntime.waitUntil` and the Anthropic client are not exercised by any test.
- **A step must finish inside its lease.** `STEP_LEASE_SECONDS = 150`; the engine call is aborted
  15 s earlier (`AbortSignal.timeout`), the model client is built with a 120 s timeout and one retry. A
  worker killed by the platform leaves an expired lease: the next `step` takes it over, which counts as one
  failed attempt (so a step that always kills its worker ends the job after 3).
- **Roles.** `reviewer` cannot create jobs, step them or upload schemes: every job ends in a write that only
  `super_admin` / `content_editor` may do. Only the creator steps a job (`super_admin` may cancel any).
  Reviewers approve schemes and unit versions; they read (not create) the drafts.
- **Spend is logged even when the output is not stored** (a late finisher after a takeover, a cancelled
  job, a failed step): the model was called and billed. `ai_usage.est_cost_usd` is NULL for a model with
  no price; the budget check sums only known costs, so set `ai.prices` before relying on the caps.
- **`stage_to` of a planned unit is validated but not stored**: `units` has no such column (the plan keeps
  it in the job `result`).
- **Fresh local stack.** The `scheme-uploads` bucket is declared in `supabase/config.toml` and created by
  the migration with `on conflict do nothing`; the two `storage.objects` policies are installed only when
  the storage schema exists. pgTAP `082` skips those assertions (with a note) if they are not there.
- **`_shared/clients.ts` still says the service role is used "ONLY for the private `packs` bucket".** It
  now also calls the four `ai_job_*` RPCs, after the caller has been authenticated and authorised. The
  comment was not edited by M2.2.
