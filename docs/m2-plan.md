# M2: Content engine (admin + Claude)

Goal: an admin uploads a scheme of work, Claude drafts the chapter plan and every unit as reviewable drafts, a
human revises, approves and publishes them, and the learner app receives them through the M1 path. Claude never
publishes anything.

Exit criterion (plan §10): P1 Basic Science Term 1 (8 teaching weeks) drafted by Claude, human-reviewed and
published. That needs a live `ANTHROPIC_API_KEY`; everything else is built and tested against a fake model first
(see "What is and is not verified").

## Status

| #    | Package                              | State                                                                                                                                                       |
| ---- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M2.1 | `authoring-core`                     | built; 367 tests against fake models; the live API path and the prompts are unverified                                                                      |
| M2.2 | server                               | seven migrations applied to the dev database; 925 pgTAP tests (436 new) pass; edge function written and tested with injected dependencies, **not deployed** |
| M2.3 | `apps/admin`                         | built; 221 tests; verified in a browser in demo mode; the live path is covered by a recording fake client and by a regression test on real server output    |
| exit | 8 units drafted, reviewed, published | waits for `ANTHROPIC_API_KEY`, the CLI deploy and your review: see [m2-live-test.md](m2-live-test.md)                                                       |

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
