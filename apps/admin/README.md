# CUSTAR admin app (content engine)

The web-first admin for the content engine (Expo SDK 57, expo-router, react-native-web). Admins upload a scheme of
work, Claude drafts chapter plans and lesson units, and a human reviews, approves and publishes them. It is never
shipped to phones. Plan: [`docs/m2-plan.md`](../../docs/m2-plan.md); job stepping: ADR 0007.

**Claude never publishes.** The only things a job writes on its own are draft `unit_versions`. Submit, approve and
publish are separate buttons pressed by a person, and a version with lint errors can be neither submitted nor
published. The review screen renders everything the tutor will consume (`UnitView` in `admin` mode: all three tabs,
tutor scripts, alt text, helper scripts).

## Run it

```bash
npm install                 # from the repo root (once)
cd apps/admin
npm run web                 # browser, demo mode (no backend needed)
```

**Demo mode** is used whenever `EXPO_PUBLIC_SUPABASE_URL` or `EXPO_PUBLIC_SUPABASE_KEY` is missing. Everything runs in
memory against sample data and a **stand-in model** (`demo-fixture-model`: it replays fixtures through the real step
engine, it is not Claude). A permanent banner on every screen says so, and the stand-in model's id is shown on every
draft. A page reload starts over.

- Sign in with any email, the email code `123456`, then the authenticator code `654321`.
- An email containing `new` shows authenticator **enrolment**; one containing `visitor` ends at "This account is not
  an admin account".
- The banner has a **demo role** switcher (super admin, content editor, reviewer, support, analyst) to show how
  buttons change. `?demoRole=reviewer` in the address signs in as that role.
- Seed: the 12 subjects, Basic Science Primary 1 Term 1 as an **approved** scheme with its two chapters of four
  units, the golden Unit 2 as an **approved** version, and the cast (Zari: female, 7. Zuri: male, almost 5; nothing
  else is stated). Read a new scheme for Basic Science, Primary 1, **Term 2 or 3** to see a full sample.
- The stand-in model does not read your document. It returns sample content for the subject, level and term you
  choose, and says so in its notes.
- The **Dev** link (demo only) opens the original fixture preview (`/preview`).

**Live mode** talks to the Supabase project. Create `apps/admin/.env` (see `.env.example`):

```
EXPO_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
EXPO_PUBLIC_SUPABASE_KEY=<publishable key>
```

Only the **publishable** key belongs here. Never put the service role key or an Anthropic key in the app
(`ANTHROPIC_API_KEY` exists only as an Edge Function secret). The account must exist already (sign-in never creates
users), have a row in `admin_users`, and use an authenticator app: every admin policy needs `aal2`.

```bash
npx expo export --platform web      # static build in dist/
```

## Screens and routes

| Route                          | Screen                                                                                                                                                                                                               |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (gate)                         | Sign-in: email code, authenticator code or enrolment (QR and secret), "not an admin account". A deep link survives sign-in.                                                                                          |
| `/`                            | Home: counts and a to-do list (schemes awaiting approval, units awaiting review, approved and ready to publish, jobs running or failed), quick links.                                                                |
| `/schemes`                     | Schemes by subject, level and term with status; filters.                                                                                                                                                             |
| `/schemes/new`                 | New scheme from a document: subject, level, term; PDF (uploaded), Word (converted in the browser with mammoth), text file or pasted text; live job progress; the editable draft. `?job=<id>` resumes.                |
| `/schemes/[schemeId]`          | A scheme: editable weeks while it is a draft, read-only once approved.                                                                                                                                               |
| `/schemes/[schemeId]/chapters` | Chapter planner: existing chapters and units with status and version counts, **Edit layout** (add, remove, reorder and move units by hand, 3 to 5 per chapter), "Propose chapters", the editable plan, "Apply plan". |
| `/units/[unitId]`              | Unit workspace: draft with Claude, live per-step progress, preview, lint, advisory AI review, revise, review and publish, version history and diff. **Edit by hand** opens the editor.                               |
| `/units/[unitId]/edit`         | **Edit by hand**: a structured text editor for the whole unit (see below). Saves a new human draft version.                                                                                                          |
| `/characters`                  | The cast bible.                                                                                                                                                                                                      |
| `/usage`                       | Usage (totals, by day, model and kind) and settings (kill switch, caps, models, prices).                                                                                                                             |
| `/jobs`, `/jobs/[jobId]`       | Recent jobs; one job's progress, error and result; resume a half-finished job.                                                                                                                                       |
| `/preview`, `/preview/[slug]`  | Developer fixture preview (demo mode only).                                                                                                                                                                          |

Every screen has loading, empty and error states. An `mfa_required` error shows "Authenticator code required" with a
button back to the sign-in step, never a blank page. Layout: a persistent left sidebar from 900 px up, a top bar with
a menu below that; it works at 390 px (not meant for phones) and has no horizontal page scroll.

Behaviours worth knowing:

- **Nothing is claimed as saved before the RPC resolved.** Save, approve, apply and publish show "Saved at ..."
  only after the call returned. Editable drafts register as unsaved: in-app links, the sidebar and a tab close or
  refresh ask first. The browser's own Back button is not intercepted.
- **Leaving a screen does not cancel a job.** `useJob` stops _watching_ (aborts the `runJob` loop); coming back
  resumes it (`?job=` on the scheme and planner screens, the active job of a unit, "Resume" on the job page). Only
  the Cancel button cancels.
- **Weeks table**: add, remove, edit rows; validation is live (duplicate weeks, blank topics, no teaching week);
  flags are listed by severity and next to their week.
- **Chapter plan**: rename chapters and units, edit objectives, stages and periods, add or remove a theme, move a
  boundary unit to the neighbouring chapter. A move is refused if it would leave a chapter outside 3 to 5 units.
- **Edit by hand** and **Edit layout** are described in their own sections below. Both are plain forms over the same
  data Claude drafts: nothing a person types is ever sent to a model, and nothing is approved or published by saving.
- **Diff**: section-level, by stable id, with before/after text and word highlights (`src/lib/diff.ts`; it agrees
  with the engine package's coarser `diffUnits` about _which_ ids changed, and adds the text).
- **Cost** is shown as "unknown" where no price is entered, never as 0. Prices are entered by the owner.

## Edit by hand (`/units/[unitId]/edit`)

Everything Claude drafts (lessons, workbook, teacher's manual, helper script, projects, revision and assessment units)
can be revised by a person, in forms, never as raw JSON. Open it from the unit workspace ("Edit by hand"). It edits the
**latest version** and saves a **new draft version** (`generated_by: 'human'`, no model, no prompt version,
`base_version_id` = the version it started from). It never edits a version in place, and never approves or publishes.

- **What is editable**: the header (title, objective, stage, theme, week when the unit has none); every section (type,
  heading, language) and its blocks (all ten types: paragraph, bullets, definition, example, dialogue, illustration,
  callout, activity steps, table, question); every question of all ten kinds with an **answer builder** (pick the
  correct option, type the accepted answers per blank, build pairs, tick the circles, sort items into groups, place tap
  areas on a picture map, list the accepted transcripts) and a **Try it** box that uses the real offline marker
  (`gradeQuestion`, the one the learner app uses); the tutor script of each section (lines, what each waits for, right
  and wrong replies, hints, jumps); the session plan (sections per period, minutes per part, with a 50 to 70 minute
  check); the workbook (tiers, drill, take-it-home, application task, practice sets); the teacher's manual (say, ask,
  watch for), the **helper script**, timing, materials, mastery guidance, the theme map; projects (brief, steps,
  materials, rubric, evidence, reflection, tutor script) and the scoring of revision and assessment units.
- **Text**: every long text has a **B** button and Ctrl/Cmd+B for `**bold**`, a live preview of the bold, and a
  character and word count; every section shows a **reading-level meter** (the same average sentence length the
  `reading_level` lint rule uses, in words and a bar).
- **Structure**: add, remove, duplicate and reorder sections, blocks, questions and the items inside them. New ids are
  generated (the type and the next free number); an existing id can never be renamed. **A section or question that was
  ever published cannot be deleted** (the button is disabled and says which version had it; checked against the whole
  published history with `lintVersionIds`); one that was never published can be.
- **Checks**: the unit is validated as you type (strict Zod parse, the publish-gate lint, the stable-id rule), a moment
  after each keystroke. Every problem is shown beside its field and in the **Checks** panel, where pressing it opens
  the card and puts the cursor in the field. **Errors block Save; warnings never do.** A new blank block is an error
  until it is written: nothing can be saved with a placeholder nobody wrote.
- **Preview**: the unit exactly as the learner app renders it (`UnitView`, admin mode, three tabs), beside the editor at
  1180 px and wider, behind an Edit/Preview switch below that.
- **Undo and redo** (Ctrl/Cmd+Z, Shift+Z or Y; 200 steps; typing in one field within a second is one step).
- **Autosave on this device** per (unit, base version) in `localStorage` (a convenience: it can be empty or blocked, and
  the editor says so). Reopening offers **Restore my work** or **Discard it**. The leave guard asks before in-app
  navigation, a refresh or a closed tab; the Back button is not guarded (the autosave covers it).
- **Save** creates the new version and opens the workspace on it. The unit's current number, chapter and week are
  written into the header (the planner owns them; the editor shows a banner when they have moved).
- **Two people at once**: if someone saved a newer version first the server refuses (`stale_base`) and nothing is lost.
  The conflict screen lists what you changed and what changed in the newer version item by item (header, each section,
  each question, the section order, the other parts), takes what only one side touched, and asks you to choose for
  anything both touched; "Combine" puts the result in the editor for you to check and save. There is deliberately **no
  "save as a separate copy"**.
- **Roles**: super admin and content editor edit; a reviewer opens the same screen read-only; support and analyst do
  not have the page. Demo mode works the same way (the DEMO banner stays).
- **Accessibility**: every control has an accessible name, tabs are real tabs, problems are text with a glyph (never
  colour alone), a live region announces undo and save, it works at 820 px and is usable at 390 px with no horizontal
  scroll.

**Not editable here** (kept exactly as they are when you save): picture uploads and `asset_id` (a picture is described
by its brief and alt text; attaching or replacing one is not done here), `audio_refs`, a block of a type this build
does not know (the only action is Remove), a question's kind (add a new question of the other kind and remove the old
one), the position of a tap area by dragging (it is typed, with a map beside it), the `lang` of a question or section
you have not set, and the enrichment-rotation rule (`enrichment_not_rotated` needs the previous unit, so it is not run
in the browser; it still runs wherever the server lints).

## Unit layout (the planner's **Edit layout**)

In a chapter an admin can **add units by hand, up to five** (and from three), remove a unit that has no draft, reorder
them, move the first or last unit of a chapter into the neighbouring chapter, edit the details of a unit that has no
draft, and add a chapter. Everything is edited in the browser; **Apply layout** sends one atomic call
(`apply_unit_layout`). The 3 to 5 rule is shown in the buttons (the add button is disabled at five and says why), enforced
by the RPC and again by `publish_unit_version`.

**Numbering.** A unit's number is its place in the term (chapter order, then position): units after a change move up
or down by themselves. A unit **with versions** is never deleted or rewritten here, and changes number or chapter only
after a confirmation that lists it ("unit 2 becomes unit 1"); a unit that was published never leaves its chapter.
**Removing** a unit archives it (the row stays, tombstoned, its number parked above 10000) so nothing is ever deleted
from under a unit that might one day be referred to. A page whose layout is out of date is refused (`layout_out_of_date`)
and offers to reload. The numbering decision and its trade-offs are in `docs/m2-plan.md` and in the migration's header.

The RPC also takes a theme **lens** for a new unit; the planner's form does not offer it (set it by planning again
or leave it to the unit's content).

**"Plan again"** still works, but it replaces units that have no draft and are not in the new plan; the screen says so.

## Roles

What the app shows or enables (the database decides; a server refusal is handled and explained):

| Capability                                                             | Roles                                 |
| ---------------------------------------------------------------------- | ------------------------------------- |
| Read schemes, units, drafts, jobs, characters                          | super admin, content editor, reviewer |
| Start a Claude job; save a scheme draft; apply a plan; edit characters | super admin, content editor           |
| Approve a scheme; approve or send back a version                       | super admin, reviewer                 |
| Submit for review; publish                                             | super admin, content editor, reviewer |
| See usage totals                                                       | super admin, content editor, analyst  |
| Edit a unit by hand (save a new human version)                         | super admin, content editor           |
| Edit the unit layout (add, remove, reorder units)                      | super admin, content editor           |
| Read the editor read-only                                              | reviewer                              |
| Read settings                                                          | super admin, content editor, reviewer |
| Change settings                                                        | super admin                           |

Support has no content screens. A role that cannot open a page is told why.

## Layout

| Path                      | What                                                                                                                 |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `src/app/`                | expo-router routes (thin); `_layout.tsx` has the sign-in gate and the shell                                          |
| `src/screens/`            | The screens                                                                                                          |
| `src/components/`         | Job panel, scheme draft editor, chapter plan editor, lint and review panels, diff, workflow bar, version history     |
| `src/api/`                | `AdminApi` (the port), the live Supabase adapter, Zod schemas, error mapping, job params check                       |
| `src/demo/`               | The in-memory backend and seed; `engine.ts` is the one file that wires the stand-in model and the in-memory job API  |
| `src/runtime/`            | `createRuntime` (live or demo by env), provider, unsaved-changes guard                                               |
| `src/jobs/`, `src/hooks/` | `JobController` (drives a job with `runJob`), `useJob`, `useLoad`, `useAction`                                       |
| `src/lib/`                | Pure, tested logic: roles, workflow, week and plan editing, unit layout rules, diff, lint view, formatting, job text |
| `src/editor/`             | The unit editor: pure logic (path updaters, ops, answer builders, validation, history, autosave, merge) and `ui/`    |
| `src/ui/`                 | Buttons, fields, tables, banners, dialogs, shell (`.web.tsx` files use the browser's `<select>` and `<img>`)         |
| `scripts/`                | `serve-dist.mjs`, `e2e-demo.mjs` (and tiny DOCX and PDF fixtures)                                                    |

The screens only call `AdminApi` (`src/api/types.ts`). `createSupabaseAdminApi(supabase, { url, publishableKey })`
is the live implementation, `createDemoAdminApi()` the demo one; `createRuntime` picks by env.

### What the live adapter calls

RPCs (all `public.*`, exact `p_` names, per `docs/m2-plan.md` and `supabase/migrations/README.md`):

| Call                                                                                          | Used for                      |
| --------------------------------------------------------------------------------------------- | ----------------------------- |
| `save_scheme_draft(p_subject_id, p_level_code, p_term, p_weeks, p_source_note)` -> uuid       | Save as draft                 |
| `approve_scheme(p_scheme_id)`                                                                 | Approve scheme                |
| `apply_chapter_plan(p_scheme_id, p_plan)` -> `{chapters, units}`                              | Apply plan                    |
| `set_unit_version_status(p_unit_version_id, p_status)`                                        | Submit, approve, send back    |
| `publish_unit_version(p_unit_version_id)` -> uuid                                             | Publish (then `publish-pack`) |
| `get_ai_settings()`, `set_app_setting(p_key, p_value)`, `get_ai_usage_summary(p_from, p_to)`  | Usage and settings            |
| `apply_unit_layout(p_scheme_id, p_layout, p_confirm_renumber)` -> counts, ids and the layout  | Edit layout                   |
| `create_unit_version_draft(...)` with `p_generated_by = 'human'`, no model, no prompt version | Edit by hand: Save            |

`create_unit_version_draft` is called by the `ai-job` function for AI drafts and by the app for hand-made versions
(always a new draft, based on the latest version; `stale_base` if someone else saved first). Reads (PostgREST): `subjects`,
`levels`, `schemes` (+`scheme_weeks`), `chapters` (+`units`, +`unit_versions` without content), `unit_versions`
(content only when one version is opened), `published_units` (also the whole snapshot history of one unit, for the stable-id rule of the editor), `characters` (read and update), `admin_users` (own row),
`ai_jobs` (without `input` and `state`). Storage: private bucket `scheme-uploads`, path
`<user id>/<uuid>-<file name>`. Edge functions: `POST ${url}/functions/v1/ai-job` (`AiJobRequest`, errors as
`AiJobErrorBody`) and `POST ${url}/functions/v1/publish-pack` (`{published_unit_id}`), with the session's access token
as bearer and the publishable key as `apikey`. Every response is validated with Zod before a screen sees it.

`usage.summary` expects `{totals, by_day, by_model, by_kind}` with `calls`, the four token counts and
`est_cost_usd` (null when unpriced) per bucket; `totals` may also carry `jobs` (or `jobs_by_status`) as a status
count map. Reconcile with the final `get_ai_usage_summary`.

## Checks

```bash
npx vitest run apps/admin           # unit tests (pure logic, live adapter with a fake supabase client, demo API)
npx tsc --noEmit -p apps/admin
npx eslint apps/admin && npx prettier --check apps/admin

npx expo export --platform web
node scripts/serve-dist.mjs dist 8126 &
PLAYWRIGHT_PATH=/opt/node-tools/node_modules/ node scripts/e2e-demo.mjs --out ./e2e-out --base http://127.0.0.1:8126
PLAYWRIGHT_PATH=/opt/node-tools/node_modules/ node scripts/e2e-editor.mjs --out ./e2e-editor-out --base http://127.0.0.1:8126
```

The browser run walks sign-in (wrong codes, authenticator), a pasted scheme, edit, the unsaved-changes guard, save,
approve, chapter plan and apply, a unit draft with live progress, the preview in all three tabs, lint and jump,
revise, history and diff, submit, approve (a content editor cannot), publish, a Word and a PDF upload, characters,
usage and settings, jobs, roles, narrow widths, "not an admin" and authenticator enrolment, with a screenshot at every
step. `e2e-editor.mjs` walks the unit editor (typing, bold, undo, a published section that cannot be deleted, errors that
block Save and jump to the field, a new block, the reading-level meter, Try it with the real marker, the session plan
meter, review of changes, Save as a new human version, the history and diff, the leave guard, the restore prompt, a
reviewer read-only, no access for support, 820 and 390 px) and the planner (add a fifth unit, a sixth refused, a unit
with a draft that cannot be removed, apply, remove a unit without a draft, the renumber confirmation), with a
screenshot at every step.

## What is verified, and what is not

Verified here: the pure logic; the live adapter against a **fake** supabase-js client (RPC names and arguments,
column lists, error mapping, response validation, the edge function calls); the demo backend through the real step
engine and the stand-in model; the whole demo flow in a real browser (Chromium via Playwright), including the Word
conversion and PDF paths.

**Not verified (cannot be from this sandbox): the whole live path.** Nothing has run against
`*.supabase.co`: not the email-code and TOTP sign-in, not `admin_users` and RLS at `aal2`, not the RPCs, the storage
upload, the `ai-job` and `publish-pack` functions (including their CORS answer to a browser call), and not real Claude
output. The adapter is written against the documented names and shapes; reconcile it with the final migrations and
function code. The email template must send the 6-digit `{{ .Token }}` for `signInWithOtp` to work.

**Verified against the live database (not through the app)**: `apply_unit_layout` and the human-version save, by pgTAP
(`supabase/tests/database/120_unit_layout.test.sql`) and by a captured live output
(`src/api/fixtures/live-layout-output.json`, checked in `liveLayout.test.ts`: the schemas the adapter parses with, the
typed errors, and the TypeScript layout rules agree with the server on the same scenario). **Not verified**: the editor
and the layout editor driving the live project through a real browser session (sign-in at `aal2` needs `*.supabase.co`),
and two people editing the same unit at once (the conflict screen is checked from fixtures in the demo preview, the
merge by unit tests, the `stale_base` refusal by pgTAP and the demo backend test).

Known limits: the browser Back button is not guarded; the app imports `zod` (hoisted from the workspace packages) but
does not list it in `package.json`, because the lockfile belongs to the integrator; native platforms are not
supported.
