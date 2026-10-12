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

| Route                          | Screen                                                                                                                                                                                                |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (gate)                         | Sign-in: email code, authenticator code or enrolment (QR and secret), "not an admin account". A deep link survives sign-in.                                                                           |
| `/`                            | Home: counts and a to-do list (schemes awaiting approval, units awaiting review, approved and ready to publish, jobs running or failed), quick links.                                                 |
| `/schemes`                     | Schemes by subject, level and term with status; filters.                                                                                                                                              |
| `/schemes/new`                 | New scheme from a document: subject, level, term; PDF (uploaded), Word (converted in the browser with mammoth), text file or pasted text; live job progress; the editable draft. `?job=<id>` resumes. |
| `/schemes/[schemeId]`          | A scheme: editable weeks while it is a draft, read-only once approved.                                                                                                                                |
| `/schemes/[schemeId]/chapters` | Chapter planner: existing chapters and units with status and version counts, "Propose chapters", the editable plan, "Apply plan".                                                                     |
| `/units/[unitId]`              | Unit workspace: draft with Claude, live per-step progress, preview, lint, advisory AI review, revise, review and publish, version history and diff.                                                   |
| `/characters`                  | The cast bible.                                                                                                                                                                                       |
| `/usage`                       | Usage (totals, by day, model and kind) and settings (kill switch, caps, models, prices).                                                                                                              |
| `/jobs`, `/jobs/[jobId]`       | Recent jobs; one job's progress, error and result; resume a half-finished job.                                                                                                                        |
| `/preview`, `/preview/[slug]`  | Developer fixture preview (demo mode only).                                                                                                                                                           |

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
- **Diff**: section-level, by stable id, with before/after text and word highlights (`src/lib/diff.ts`; it agrees
  with the engine package's coarser `diffUnits` about _which_ ids changed, and adds the text).
- **Cost** is shown as "unknown" where no price is entered, never as 0. Prices are entered by the owner.

## Roles

What the app shows or enables (the database decides; a server refusal is handled and explained):

| Capability                                                             | Roles                                 |
| ---------------------------------------------------------------------- | ------------------------------------- |
| Read schemes, units, drafts, jobs, characters                          | super admin, content editor, reviewer |
| Start a Claude job; save a scheme draft; apply a plan; edit characters | super admin, content editor           |
| Approve a scheme; approve or send back a version                       | super admin, reviewer                 |
| Submit for review; publish                                             | super admin, content editor, reviewer |
| See usage totals                                                       | super admin, content editor, analyst  |
| Read settings                                                          | super admin, content editor, reviewer |
| Change settings                                                        | super admin                           |

Support has no content screens. A role that cannot open a page is told why.

## Layout

| Path                      | What                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `src/app/`                | expo-router routes (thin); `_layout.tsx` has the sign-in gate and the shell                                         |
| `src/screens/`            | The screens                                                                                                         |
| `src/components/`         | Job panel, scheme draft editor, chapter plan editor, lint and review panels, diff, workflow bar, version history    |
| `src/api/`                | `AdminApi` (the port), the live Supabase adapter, Zod schemas, error mapping, job params check                      |
| `src/demo/`               | The in-memory backend and seed; `engine.ts` is the one file that wires the stand-in model and the in-memory job API |
| `src/runtime/`            | `createRuntime` (live or demo by env), provider, unsaved-changes guard                                              |
| `src/jobs/`, `src/hooks/` | `JobController` (drives a job with `runJob`), `useJob`, `useLoad`, `useAction`                                      |
| `src/lib/`                | Pure, tested logic: roles, workflow, week and plan editing, diff, lint view, formatting, job text                   |
| `src/ui/`                 | Buttons, fields, tables, banners, dialogs, shell (`.web.tsx` files use the browser's `<select>` and `<img>`)        |
| `scripts/`                | `serve-dist.mjs`, `e2e-demo.mjs` (and tiny DOCX and PDF fixtures)                                                   |

The screens only call `AdminApi` (`src/api/types.ts`). `createSupabaseAdminApi(supabase, { url, publishableKey })`
is the live implementation, `createDemoAdminApi()` the demo one; `createRuntime` picks by env.

### What the live adapter calls

RPCs (all `public.*`, exact `p_` names, per `docs/m2-plan.md` and `supabase/migrations/README.md`):

| Call                                                                                         | Used for                      |
| -------------------------------------------------------------------------------------------- | ----------------------------- |
| `save_scheme_draft(p_subject_id, p_level_code, p_term, p_weeks, p_source_note)` -> uuid      | Save as draft                 |
| `approve_scheme(p_scheme_id)`                                                                | Approve scheme                |
| `apply_chapter_plan(p_scheme_id, p_plan)` -> `{chapters, units}`                             | Apply plan                    |
| `set_unit_version_status(p_unit_version_id, p_status)`                                       | Submit, approve, send back    |
| `publish_unit_version(p_unit_version_id)` -> uuid                                            | Publish (then `publish-pack`) |
| `get_ai_settings()`, `set_app_setting(p_key, p_value)`, `get_ai_usage_summary(p_from, p_to)` | Usage and settings            |

`create_unit_version_draft` is called by the `ai-job` function, not by the app. Reads (PostgREST): `subjects`,
`levels`, `schemes` (+`scheme_weeks`), `chapters` (+`units`, +`unit_versions` without content), `unit_versions`
(content only when one version is opened), `published_units`, `characters` (read and update), `admin_users` (own row),
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
```

The browser run walks sign-in (wrong codes, authenticator), a pasted scheme, edit, the unsaved-changes guard, save,
approve, chapter plan and apply, a unit draft with live progress, the preview in all three tabs, lint and jump,
revise, history and diff, submit, approve (a content editor cannot), publish, a Word and a PDF upload, characters,
usage and settings, jobs, roles, narrow widths, "not an admin" and authenticator enrolment, with a screenshot at every
step.

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

Known limits: the browser Back button is not guarded; the app imports `zod` (hoisted from the workspace packages) but
does not list it in `package.json`, because the lockfile belongs to the integrator; native platforms are not
supported.
