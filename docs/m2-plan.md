# M2: Content engine (admin + Claude)

Goal: an admin uploads a scheme of work, Claude drafts the chapter plan and every unit as reviewable drafts, a
human revises, approves and publishes them, and the learner app receives them through the M1 path. Claude never
publishes anything.

Exit criterion (plan §10): P1 Basic Science Term 1 (8 teaching weeks) drafted by Claude, human-reviewed and
published. That needs a live `ANTHROPIC_API_KEY`; everything else is built and tested against a fake model first
(see "What is and is not verified").

## Status

| #    | Package                              | State                                                                                                                                                                                    |
| ---- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M2.1 | `authoring-core`                     | built; 367 tests against fake models; the live API path and the prompts are unverified                                                                                                   |
| M2.2 | server                               | seven migrations applied to the dev database; 925 pgTAP tests (436 new) pass; edge function written and tested with injected dependencies, **not deployed**                              |
| M2.3 | `apps/admin`                         | built; 221 tests; verified in a browser in demo mode; the live path is covered by a recording fake client and by a regression test on real server output                                 |
| M2.4 | human editing, units by hand         | built; one RPC (`apply_unit_layout`, two migrations applied to dev) with 141 pgTAP tests; 455 admin tests (234 new); the editor and the layout editor verified in a browser in demo mode |
| exit | 8 units drafted, reviewed, published | waits for `ANTHROPIC_API_KEY`, the CLI deploy and your review: see [m2-live-test.md](m2-live-test.md)                                                                                    |

## Flow

```
upload scheme (PDF, DOCX, text)
   -> job scheme_ingest   (Claude reads the document, returns an EDITABLE scheme draft + flags)
   -> admin edits, saves the draft (save_scheme_draft), approves it (approve_scheme)
   -> job chapter_plan    (deterministic grouping into 3-5 units, Claude titles chapters/units, proposes themes)
   -> admin edits, applies the plan (apply_chapter_plan)  => chapters and units rows (draft)
   -> job unit_generate   (outline, one step per section, workbook, manual, assemble, lint, review, repair)
   -> draft unit_versions row (generated_by = 'ai')  + lint report + advisory review flags
   -> admin reads it with the exact learner renderer, asks for changes (job unit_revise => new draft version)
   -> submit for review -> approve (reviewer / super_admin) -> publish_unit_version -> publish-pack  (M1 path)
```

Contracts: [`packages/authoring-core/src/contract.ts`](../packages/authoring-core/src/contract.ts) (job protocol,
model port, settings, cast, engine interface), ADR 0007 (client-driven stepping), ADR 0006 (2 to 5 enrichment
sections), plan §5 (Claude call rules).

## Work packages

| #    | Package                                                                                                                                                 | Where                                 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| M2.1 | Authoring core: model port adapter, `FakeLlm` and a fixture-backed demo model, prompts, the step engine, `runJob`, Deno vendor bundle, live-eval script | `packages/authoring-core`, `scripts/` |
| M2.2 | Server: `app_settings`, `ai_jobs`, `ai_usage`, upload bucket, cast facts, RPCs, the `ai-job` edge function, pgTAP tests                                 | `supabase/`                           |
| M2.3 | Admin app: MFA sign-in, scheme upload and review, chapter planner, unit workspace, characters editor, usage panel, demo mode                            | `apps/admin`                          |

## The server surface (what M2.2 builds and M2.3 calls)

All RPCs are `public.*` thin `SECURITY INVOKER` wrappers over `private.*` implementations (repo rules), callable by
`authenticated` only, and require an admin role at `aal2` as listed.

| Name                                                                                                                                    | Roles                                       | Does                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `save_scheme_draft(p_subject_id, p_level_code, p_term, p_weeks, p_source_note) -> uuid`                                                 | `super_admin`, `content_editor`             | Creates or replaces the DRAFT scheme for (subject, level, term) with `p_weeks` (`SchemeWeek[]` JSON, validated). Refuses a scheme that is not `draft` (`scheme_not_draft`).                                                                                                                                                     |
| `approve_scheme(p_scheme_id) -> void`                                                                                                   | `super_admin`, `reviewer`                   | `draft` -> `approved`. A scheme needs at least one teaching week.                                                                                                                                                                                                                                                               |
| `apply_chapter_plan(p_scheme_id, p_plan) -> jsonb`                                                                                      | `super_admin`, `content_editor`             | Needs an `approved` scheme. Creates chapters and units (status `draft`) from a `ChapterPlan` JSON; re-applying updates titles, objectives and stages of units that have no version yet, and refuses to touch a unit that has one (`unit_has_versions`). Returns `{chapters, units}` counts. Validates 3 to 5 units per chapter. |
| `create_unit_version_draft(p_unit_id, p_content, p_lint_report, p_generated_by, p_model, p_prompt_version, p_base_version_id) -> jsonb` | `super_admin`, `content_editor`             | Inserts the next `unit_versions` row as `draft` and returns `{id, version}`. `p_base_version_id` must be the latest version of the unit or null for the first (`stale_base` otherwise). Content must carry `schema_version` and `header` (cheap check; the Zod parse is the client's and the engine's job).                     |
| `set_unit_version_status(p_unit_version_id, p_status) -> void`                                                                          | see right                                   | `draft -> in_review` (`super_admin`, `content_editor`, `reviewer`); `in_review -> approved` and `in_review -> draft` (`reviewer`, `super_admin`). Other moves raise `illegal_status_move`. The existing guard trigger stays the last line of defence.                                                                           |
| `get_ai_settings() -> jsonb`                                                                                                            | content staff                               | The assembled `AiSettings` (defaults for missing keys).                                                                                                                                                                                                                                                                         |
| `set_app_setting(p_key, p_value) -> void`                                                                                               | `super_admin`                               | Upserts one `APP_SETTING_KEYS` key after validating its shape. Audited.                                                                                                                                                                                                                                                         |
| `get_ai_usage_summary(p_from, p_to) -> jsonb`                                                                                           | `super_admin`, `content_editor`, `analyst`  | `{totals, by_day, by_model, by_kind}`: calls, tokens (all four kinds), estimated cost (null when unpriced), jobs by status.                                                                                                                                                                                                     |
| `apply_unit_layout(p_scheme_id, p_layout, p_confirm_renumber default false) -> jsonb` (M2.4)                                            | `super_admin`, `content_editor`             | One atomic call that sets the chapter, order and term-wide number of every live unit of an approved scheme: adds units (and chapters), archives named units that have no version, 3 to 5 per chapter. See "M2.4" below.                                                                                                         |
| `publish_unit_version(p_unit_version_id)` (existing, M0)                                                                                | `super_admin`, `content_editor`, `reviewer` | Unchanged.                                                                                                                                                                                                                                                                                                                      |

Plus:

- **Tables.** `app_settings(key pk, value jsonb, updated_at, updated_by)`; `ai_jobs` (see ADR 0007; `input` and
  `state` jsonb; `lease_until`, `lease_token`, `attempts`, `progress`, `result`, `error`, `unit_id`, `scheme_id`,
  `idempotency_key` unique per creator, timestamps); `ai_usage` (one row per model call: job, label, task, model,
  the four token counts, `est_cost_usd` nullable, `stop_reason`, `duration_ms`, creator, time). RLS on; clients read
  `ai_jobs` without `input` and `state` (column grants); nobody writes `ai_jobs` or `ai_usage` except the edge
  function through `service_role`-only RPCs (`ai_job_*`).
- **Storage.** Private bucket `scheme-uploads` (PDF, DOCX, plain text; 20 MB). Content staff at `aal2` may upload and
  read; nobody else.
- **Characters.** The existing `characters` table (content staff write). The M2 migration writes the owner's facts
  (`OWNER_CAST_FACTS` in the contract) into Zari and Zuri's `traits`, plus `derived_guidance` labelled as derived
  from age.
- **Edge function `ai-job`.** Body and responses are `AiJobRequest` / `AiJobResponse` / `AiJobErrorBody` in the
  contract. It verifies the JWT and `aal2`, reads with the caller's JWT, and uses `service_role` only for the
  `ai_job_*` lease/state/usage RPCs. It builds the engine input from the database (`JobInputResolver`), runs steps
  in `EdgeRuntime.waitUntil`, enforces the kill switch and the budgets before every step, and for `unit_generate` /
  `unit_revise` saves the finished draft with `create_unit_version_draft` using the caller's JWT.
- **Secrets.** `ANTHROPIC_API_KEY` is an Edge Function secret only.

## Prompting rules (M2.1)

- A stable, cacheable **system prefix**: condensed brief rules (stages, layers, session shape, mastery gate,
  religion-neutral, Nigerian anchor plus a global window), the schema guide, the **cast bible** (facts only, derived
  guidance labelled as derived), and the golden Unit 2 as the exemplar of shape and voice. Per-step context
  (objective, stage, theme, prior units, the section being written) goes after the cache breakpoint.
- Enrichment: 2 to 5 types from the menu, each at most once, rotating away from the previous unit's set (ADR 0006).
  The template's five are the default for a Primary 1 lesson.
- Content from an uploaded document is **data, never instructions**: it is fenced in the prompt and the system
  prompt says so. Everything the tutor will later consume (tutor scripts, alt text, helper scripts) is generated
  into visible fields so the reviewer sees it.
- The AI never invents facts about characters. Zari is female and 7; Zuri is male and almost 5; nothing else is
  known. In particular the characters are not called siblings or friends until the owner says so.
- Claude-judged checks (religious neutrality, reading level, factual sanity, cast consistency) produce advisory
  `ReviewFlag`s. They never block and never approve.
- The deterministic gate is the content-schema Zod parse plus `lintUnit`; a unit with lint errors gets at most two
  repair steps and is then saved anyway as a draft with its errors visible (a human decides).

## M2.4: human editing and units added by hand (owner requirement, 2026-10-12)

The owner requires that **everything Claude drafts (lessons, units, worksheets) can be revised by a person in a
text-editor space**, and that an admin can **add units to a chapter by hand, up to five**. Until M2.4 the only way to
change a draft was "Revise with Claude", and units came only from scheme weeks.

- **Editor** (`/units/[unitId]/edit`, "Edit by hand" in the unit workspace): edits the whole unit as structured fields,
  not raw JSON: header, sections, blocks of every type (text with `**bold**`, bullets, definitions, examples, dialogue,
  callouts, steps, tables, illustration brief and alt text), questions of every kind with answer builders and a "Try
  it" box that uses the real offline grader, tutor-script nodes, the session plan with a 50 to 70 minute check, the
  workbook (tiers, drill, take-it-home, not-yet, practice sets) and the teacher's manual including the helper script;
  projects, revision and assessment units too. Live Zod and lint messages beside the field and in a summary panel that
  jumps to the field, a reading-level meter per section, undo and redo, a local autosave with a restore prompt, a
  leave guard and a side-by-side preview with `UnitView`. Details: `apps/admin/README.md`.
- **Save** creates a **new `human` version** through `create_unit_version_draft` (no model, no prompt version, `base` =
  the latest version; never edits a version in place). `stale_base` shows a **conflict screen** with a by-item merge
  (no "save as a separate copy"). Approval is still a separate step for a reviewer.
- **Ids**: existing ids cannot be renamed. An id that was never published may be deleted; an id of any published
  snapshot of the unit may not (`lintVersionIds` against the whole published history, not only the previous draft;
  the buttons are disabled with the reason, and a save that lost one is refused).
- **Planner** ("Edit layout" on the chapter planner): add a unit to a chapter (up to 5), remove a unit that has no
  version, reorder within a chapter, move the first or last unit to the neighbouring chapter, edit the details of a
  unit that has no draft, add a chapter; one atomic RPC, `apply_unit_layout`, for the whole layout. The 3 to 5 rule is
  enforced in the planner's buttons, in the RPC, in `apply_chapter_plan` (unchanged) and in `publish_unit_version`.

### The numbering decision

`units.unit_no` is the 1-based **ordinal of the unit within its term**, in teaching order (chapter number, then
position in the chapter). It is what the learner app prints ("Unit 5: ..."), what `apply_chapter_plan` requires to be
unique over a plan, and what `header.unit_no` of the unit content means. `apply_unit_layout` therefore gives every live
unit its rank in the layout: dense, unique term-wide, always consistent.

What that means in practice, and the trade-offs:

- A unit **without versions** is renumbered, moved and edited freely. A unit **with versions** keeps its row, id and
  versions; it changes number or chapter only when the caller passes `p_confirm_renumber` after being told which
  numbers change (the planner computes the same list before calling, the server refuses with the list in the error
  DETAIL otherwise). Its title, objective, kind, stage, periods and week are never edited by the layout (that is what
  new versions are for), and it is never removed. A unit that was **ever published** stays in its chapter.
- **Trade-off 1, adding in an earlier chapter shifts every later number by one**, including units that already have
  drafts (so it needs the confirmation). Adding at the end of the last chapter, or removing the last unit, renumbers
  nothing that has a version. The alternative (sparse numbers, "Unit 9" before "Unit 5") renumbers nothing but prints
  numbers out of order, breaks the learner app's sort and the plan's own uniqueness rule, so it was not chosen.
- **Trade-off 2, drafts keep the number they were written under.** `header.unit_no` and `header.chapter` in a version
  are not rewritten (published snapshots are immutable, drafts are never edited in place). The editor shows a banner
  when a version's header differs from the unit row and writes the current values into the header of the next version
  it saves. Until then a draft can say "Unit 5" in its header while the unit is now Unit 6; the workspace shows the
  unit row's number.
- **Trade-off 3, removal is archival.** A removed unit (it must have no version) becomes `archived` with a tombstone and
  its number parked above 10000 inside its chapter, which frees the slot for the unique constraint. Nothing is deleted
  from under a unit that something might refer to; archived units are ignored by the 3 to 5 count and cannot get a
  version. The cost is a few dormant rows. (`apply_chapter_plan` still hard-deletes version-less units a new plan does
  not contain, as before: re-planning is a different, destructive tool, and the planner says so.)
- **Trade-off 4, optimistic concurrency, not merging.** A layout must account for exactly the live chapters and units
  (`layout_out_of_date` otherwise), so a stale page can never archive a colleague's unit; the person reloads and
  redoes the change. The call takes the scheme row `FOR UPDATE` (it serialises with `apply_chapter_plan` and other
  layouts) and writes in id order, because every write draws a global `sync_seq` (see the migrations README).
- **Trade-off 5, the TypeScript copy.** The planner previews numbers and the demo backend applies layouts with a
  TypeScript mirror of the SQL rules (`src/lib/unitLayout.ts`). The SQL is the authority: the same scenario runs in
  pgTAP (`120_unit_layout.test.sql`, 141 assertions), in a Vitest test and against a captured live output
  (`src/api/fixtures/live-layout-output.json`), so the two cannot drift silently.

Verified: the RPC against the live dev database (pgTAP, including the regression runs of `000`, `050`, `081` and `082`,
and the security and performance advisors), the editor and the layout editor in a real browser in demo mode
(`apps/admin/scripts/e2e-editor.mjs`). Not verified: either screen driving the live project through a signed-in browser
session (this sandbox cannot reach `*.supabase.co`), and two people editing the same unit at the same time live.

## Admin app screens (M2.3)

Sign-in (email code, then TOTP; enrol on first use), Home (to-do: schemes awaiting approval, units awaiting review),
Schemes (upload, extraction review/edit, approve), Chapter planner (edit, apply), Unit workspace (list per chapter,
generate, live progress, preview with `UnitView` in admin mode with all three tabs, lint and review panels, revise
chat, version history with a section-level diff, submit/approve, publish + build pack), Characters (edit facts and
derived guidance), Usage (tokens, estimated cost, kill switch, budgets, model names, prices). A demo mode runs the
whole flow against an in-memory backend and a **fixture-backed fake model**; it is labelled "DEMO" everywhere and
never claims to be Claude.

## What is and is not verified

Built and tested here: the contract, the engine and prompts against a scripted fake model (shape, retries,
refusals, truncation, schema repair, resumption, ID stability, lint wiring), the SQL (pgTAP and live-database
checks), the edge function handler with injected dependencies, the admin screens in a browser in demo mode.

Not verifiable without a live key and your accounts: the quality of real Claude output (prompts are tuned blind
until the first live run), the Anthropic request parameters against the live API (checked against the SDK's types,
not the service), the deployed edge function (this sandbox cannot reach `*.supabase.co`; deploy with the CLI), the
MFA sign-in flow against the real project, and the 8-unit exit criterion. `packages/authoring-core/scripts` has an
opt-in live evaluation that runs the P1 Basic Science scheme through the real engine and writes a report; it needs
`ANTHROPIC_API_KEY` in the environment and does nothing without it.

## Prerequisites from you

1. `ANTHROPIC_API_KEY` as a Supabase Edge Function secret (dashboard: Edge Functions, Secrets). Never paste it in
   chat.
2. Optionally the same key as an environment secret for this cloud session (environment menu, edit, network
   secrets or variables; a new session picks it up) so the live evaluation can run here.
3. Deploy the functions with the CLI (`supabase functions deploy ai-job get-pack-download publish-pack`).
4. Enter the model prices in the admin Usage screen if you want cost estimates.
5. Zari and Zuri's relationship and personality when you decide them (the characters editor); until then the
   generator uses only the stated facts.
