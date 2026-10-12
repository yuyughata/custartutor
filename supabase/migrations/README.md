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
- Append-only tables (`consents`, `audit_log`) and `published_units` have `UPDATE`/`DELETE`/`TRUNCATE`
  revoked from every API role, `service_role` included.

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

The 23 tables are: `profiles`, `admin_users`, `households`, `household_members`, `children`,
`child_secrets`, `child_access`, `invites`, `grownup_pins`, `grownup_elevations`, `consents`,
`audit_log`, `levels`, `subjects`, `schemes`, `scheme_weeks`, `themes`, `theme_units`, `characters`,
`chapters`, `units`, `unit_versions`, `published_units`; plus the view `member_display`.

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
| `published_units`                                      | `is_current and deleted_at is null`: everyone; history: content staff | **none** (`publish_unit_version` only)                                                |

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

Elevation-gated actions: invite creation, member removal, grant/revoke of tutor access, PIN change,
granting consent, changing a child's daily limit, deleting/restoring a child.

## Sync contract

Syncable tables: `children`, `household_members`, `child_access`, `levels`, `subjects`, `chapters`,
`units`, `published_units`. Each has `sync_seq bigint not null` (stamped from `public.sync_seq_global`
by `private.set_sync_seq()` on every INSERT and UPDATE, indexed) and `deleted_at`.

- **The client cursor is `sync_seq`, never `updated_at`.**
- Removal is a **tombstone** (`deleted_at` set, row kept and still selectable by whoever could see the
  live row), never a hard delete. Revoked grants carry both `revoked_at` and `deleted_at`.
- A transaction that drew a lower `sync_seq` can commit after one that drew a higher value, so clients
  must pull with a small overlap (cursor minus a safety margin) and apply rows idempotently.
- `published_units` is visible only while `is_current and deleted_at is null`; a superseded snapshot
  disappears and its replacement carries a newer `sync_seq`. Unpublishing needs its own RPC (not built).

## Tests (pgTAP)

`supabase/tests/database/*.test.sql`, each file `begin; ... select * from finish(); rollback;`:

| File                                   | Tests | Covers                                                                                              |
| -------------------------------------- | ----: | --------------------------------------------------------------------------------------------------- |
| `000_hardening.test.sql`               |    24 | RLS everywhere, anon has nothing, function ACL whitelist, definer hygiene, append-only, seed data   |
| `010_households_children.test.sql`     |    47 | household isolation, no self-join, tutor scope, profiles/`member_display`, parental-control guard   |
| `020_invites_tutors.test.sql`          |    51 | invite hash/single-use/expiry/elevation, grant, revoke, removal, re-invite                          |
| `030_grownup_pin.test.sql`             |    51 | PIN never readable, bcrypt, back-off, lockout, elevation lifecycle, audit                           |
| `040_consents_audit_admin.test.sql`    |    40 | consents append-only, audit visibility, admin_users, support/analyst boundary                       |
| `050_curriculum_publish.test.sql`      |    64 | draft visibility (non-admin, aal1), review workflow, publish gate, pointer flip, immutability       |
| `060_sync.test.sql`                    |    13 | `sync_seq`, tombstones, indexes                                                                     |

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

## Types

`packages/supabase/src/database.types.ts` is generated; regenerate after **every** migration and commit:

```sh
supabase gen types typescript --local | npx prettier --stdin-filepath packages/supabase/src/database.types.ts > packages/supabase/src/database.types.ts
```

(or the MCP `generate_typescript_types`, then `prettier --write` the file: the repo's `format:check` would
otherwise fail on the generator's quote and semicolon style). Hand-written domain unions
(`LevelCode`, `UnitVersionStatus`, ...) and `DbErrorMessage` live in `packages/supabase/src/index.ts`
and must be kept in step with the CHECK constraints and RPC messages by hand.

## Advisors (Supabase `get_advisors`)

Last run after `hardening_followups`: **no ERROR or WARN, security or performance.**

Deliberately accepted (INFO only):

- **`rls_enabled_no_policy` x4** on `child_secrets`, `invites`, `grownup_pins`, `grownup_elevations`.
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
- **Membership epoch** (plan section 3) is not implemented; removal is delivered as tombstones only.
- **First `super_admin`** must be inserted by hand (`insert into public.admin_users`, as the owner);
  TOTP enrolment is a Supabase Auth setting, not a schema feature.
