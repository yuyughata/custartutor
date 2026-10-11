# CUSTAR Tutor — Master Build Plan (v2, after architecture review)

## Context

CUSTAR Tutor is an LMS with an interactive AI tutor for Nigerian Primary 1–6 pupils. Lessons follow the NERDC scheme of work (the "base layer") and are enriched using the Master Development Brief v1.2 (story openers, themes, mastery gating, Think Deeper, Quick-fire, workbook, teacher's manual).

Claude does two jobs:

1. **Authoring.** Admins collaborate with Claude to turn an uploaded scheme of work into chapters, units, workbooks and teacher's manuals.
2. **Tutoring.** A safe, scoped tutor talks with the child, grounded in the published unit.

**Starting state (verified):**

- The git repo is empty (no commits). Working branch: `claude/vigilant-goldberg-qshyvy`.
- Supabase project **CUSTAR Tutor** (`kjmjyxherydvefwtzmez`, eu-west-1) is empty: no tables, migrations or edge functions. `pgcrypto`, `uuid-ossp` and `supabase_vault` are installed; `pg_cron`, `pg_net`, `pgmq`, `pg_trgm`, `pgtap` and `vector` are available.
- Tooling: Node 22, npm 10; Expo SDK 57, expo-router 57, expo-sqlite 57, supabase-js 2.117, @anthropic-ai/sdk 0.133, zod 4.
- Reference inputs: the Master Brief (docx), P1 Basic Science scheme (PDF, 3 terms × 13 weeks), and the P1 T1 Unit 2 template (PDF, the "golden unit").

**Decisions already made by the user:**

- **Home learning only.** Households of guardians plus tutors (teachers) linked to specific families. No school/class/org tenancy.
- **"Teaching assistant" = a human helper** who co-pilots a pre-reader's lesson using a script from the teacher's manual.
- **Student tutor model: Claude Sonnet 5.5** (per-task config). Admin authoring: **Claude Opus 5.5**.
- Expo/React Native, Supabase "CUSTAR Tutor", text first with the voice framework built in, offline lessons, a PIN-protected grown-ups area.

**Design calls I'm making (shout if you disagree):**

- Two Expo apps in one npm-workspaces monorepo: `apps/learner` (iOS/Android) and `apps/admin` (Expo web-first). Admin code never ships to children's phones. Web-only components (`*.web.tsx`) are allowed for dense admin UI (tables, diffs).
- Children have no accounts or email. A guardian's session owns child profiles (profile picker). This minimises child data under the Nigeria Data Protection Act 2023.
- Lesson content is **structured JSON** (Zod-validated), never free-form markdown. One unit record yields the textbook, workbook and teacher's manual, in-app and as printable PDFs.
- The learner app is **local-first**: SQLite is the read model and the network is a sync layer, from the first learner milestone. Offline is not retrofitted.

---

## 1. Architecture

```
custartutor/
  CLAUDE.md                       # conventions, commands, "NERDC dominant; enrichment adds" rule
  package.json                    # npm workspaces
  apps/
    learner/                      # Expo SDK 57, expo-router: (auth) (child) (grownups)
    admin/                        # Expo web-first: content engine, users, analytics, support
  packages/
    content-schema/               # Zod: UnitContent (by kind), Scheme, Question, TutorScript, lint, migrate_vN
    lesson-renderer/              # RN components (peerDeps only): section cards, blocks, question widgets
    supabase/                     # typed client, generated DB types, RPC wrappers
    design-tokens/                # colours/type from the template (CORE teal, ENRICH amber)
  supabase/
    migrations/                   # SQL, git is the source of truth
    functions/_shared/            # caller-JWT client, job worker, vendored schema, redaction, usage log
    functions/                    # ai-* and tutor-chat (see §5)
    seed/  tests/                 # seeds; pgTAP RLS tests (run in CI via `supabase test db`)
  docs/  brief/ reference/ adr/   # brief as markdown; scheme + template PDFs (fixtures, private repo only)
  scripts/                        # pack builder (Node), vendor-schema (esbuild), drift checks
```

**Stack:**

- Expo Router, TypeScript strict, TanStack Query, Zustand, `expo-sqlite` (WAL, exclusive transactions, `user_version` migrations), `expo-file-system`, `expo-secure-store`, `expo-print` + `expo-sharing`, `expo-speech`/`expo-audio`, `expo/fetch` (streaming).
- Supabase: Postgres + RLS, Auth, Storage, Realtime, Edge Functions (Deno/TS), `pg_cron`, `pgmq`.
- Claude through `@anthropic-ai/sdk` (`npm:` import in Deno). The key lives only in the Edge Function secret `ANTHROPIC_API_KEY`.
- **Deno ↔ monorepo:** edge functions can only bundle files under `supabase/functions`, so `content-schema` is vendored there by an esbuild script (`scripts/vendor-schema`) with a CI drift check. `lesson-renderer` and other RN packages declare `react`/`react-native`/`expo-*` as `peerDependencies` (lint-enforced) to avoid duplicate-React hook errors.

## 2. Roles, sessions and the security model

| Role                                                                | Who                   | Auth                                                                                                     | Can do                                                                  |
| ------------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **Admin** (super_admin, content_editor, reviewer, support, analyst) | CUSTAR staff          | Supabase email + **mandatory TOTP; every admin policy/RPC requires `aal2`**                              | Admin area by sub-role                                                  |
| **Guardian**                                                        | Parent/guardian       | **Email OTP (6-digit code, primary)** or Google; SMS OTP secondary (Nigerian SMS delivery is unreliable) | Own household and children                                              |
| **Tutor** (teacher)                                                 | Invited by a guardian | Same as guardian                                                                                         | **Only the children the guardian assigns** (per-child grant, revocable) |
| **Helper** (teaching assistant)                                     | Adult/sibling/aide    | No account; guardian starts a helper session in child mode                                               | Co-pilot UI only; no grown-up access                                    |
| **Student**                                                         | Child                 | No account; profile in the guardian's device session, optional picture-passcode                          | Learn only                                                              |

**The guardian-token problem and the fix.** A child using a parent's phone holds a real guardian JWT, so a client-side PIN alone would protect nothing that matters.

- **Child mode is the default state** of the app. Sensitive server actions (read transcripts, export/delete data, invite or remove tutors, change PIN, billing) require a **short-lived grown-up elevation**: the PIN is verified **server-side** by a rate-limited RPC (bcrypt via `pgcrypto`, lockout with back-off), which writes a row in `grownup_elevations(device_id, expires_at ≈ 10 min)`. RLS/RPCs on those actions check it.
- The PIN hash is **never in a client-readable table**. Offline, the PIN gate is a UI-only check against a salted hash with a device-bound pepper in the Keystore; this is acceptable because offline there is no server data to expose beyond the local cache.
- Sensitive data (transcripts) is **not cached** in the child-mode local store; it is fetched only under elevation.

**RLS rules:**

- Helpers `private.is_household_member()`, `private.can_access_child()` and `private.has_admin_role()` are `SECURITY DEFINER`, `search_path = ''`, use `(select auth.uid())`, and live in a non-exposed schema.
- `household_id` and `child_id` are **denormalised onto every child-data row**; policies join to `children`, never trust client path segments. Storage `child-uploads` verifies the child belongs to the household.
- No self-join to a household. Invites are single-use, hashed, expiring tokens accepted through a `SECURITY DEFINER` RPC. Tutor grants are per child, and removal triggers a local purge on the next sync.
- `profiles` are not readable across members; members see a `member_display` view (name only).
- **Draft and published content are separate:** `unit_versions` (drafts, lint reports) is admin-only; `published_units` (immutable snapshot, `schema_version`, pointer per unit) is the only table authenticated users read.
- Append-only tables (`progress_events`, `audit_log`, `consents`) get `REVOKE UPDATE, DELETE`; `audit_log` is written by triggers only.
- Edge functions read with the **caller's JWT**; the service role is used only for narrow, named writes (job state, usage log, publish).
- Insider access: `analyst` sees aggregate views with small-cell suppression; `support` gets per-ticket, guardian-granted, time-boxed access to a household.
- Uploads: strip EXIF/GPS by re-encoding (`expo-image-manipulator`), enforce size and MIME limits.

**Offline auth:** authorise the _device_, not just the session. Cache a household snapshot with a server-anchored `last_verified` plus a monotonic max-seen-time check (clock-rollback defence); bounded grace window (30 days, tunable). An expired JWT blocks **sync only, never playback**. Persist the Supabase session with the "encrypt with a key in SecureStore" pattern (SecureStore values > ~2 KB are unreliable) and serialise token refresh through one mutex.

## 3. Data model (Postgres, RLS everywhere)

Tables are created **just-in-time** in the milestone that uses them. M0 ships only identity, consents, curriculum and the publish pointer.

**Identity / households:** `profiles`, `admin_users(role)`, `households`, `household_members(role guardian|tutor, status)`, `child_access(child_id, tutor_user_id)`, `invites`, `children(household_id, display_alias, avatar, level_id, reading_mode reader|pre_reader, picture_passcode_hash, daily_limit_min)`, `grownup_elevations`, `consents(version, scope, granted_at, withdrawn_at)`, `entitlements` (billing-ready, unused).

**Curriculum:**

- `levels` (P1–P6, `stage` absorb|connect|express as data); `subjects(kind core|elective|extracurricular, curriculum_source nerdc|global)`.
- `schemes(subject, level, term)` + `scheme_weeks(week_no, kind teaching|mid_term_exam|break|revision|exam|closing, topic, subtopics[])`: the NERDC base layer, never rewritten by AI generation.
- `chapters` (**3–5 units each**, validator-enforced) and `units(kind lesson|mini_project|term_project|revision|assessment, week_no, objective, stage, periods)`.
- `unit_versions` (drafts: `content jsonb`, `schema_version`, `generated_by`, `model`, `prompt_version`, `lint_report`, `status`, `base_version_id` for optimistic concurrency) and `published_units` (immutable snapshot + pointer).
- `themes` + `theme_units(lens)`, `characters` (cast bible), `assets` (images/audio/briefs, content hash), `unit_questions` (read-model projected from published JSON).

**Learning data:**

- `progress_events` is append-only. Unique `(child_id, client_event_id)` plus `device_id` and a per-device sequence number; the server stamps `received_at` and `sync_seq`.
- `unit_progress` is **derived server-side by an idempotent function over events**, using commutative rules; the client never stores derived state independently, and the server wins on pull. Mastery is keyed to `unit_id`, **not `unit_version`**, so republishing never un-masters a child.
- `tutor_sessions`, `tutor_messages` (client turn UUID, input_mode, safety flags), `notebook_entries`, `project_submissions`, `worksheet_downloads`.

**Operations:** `ai_jobs`, `ai_usage` (tokens, cache hits, est. cost), `app_settings` (kill switch, per-task models), `announcements`, `push_tokens`, `support_tickets` + messages, `safeguarding_cases`, `audit_log`.

**Sync metadata:** every syncable table gets a server `sync_seq` (global sequence set by trigger) and tombstones (`deleted_at`); a household **membership epoch** forces a full resync when access changes. `updated_at` is not used as a cursor (out-of-order commits and unreliable device clocks).

## 4. Unit content schema

`UnitContent` in `packages/content-schema`, **discriminated by `kind`** (lesson, mini_project, term_project, revision, assessment), directly encoding Brief §7 for lessons:

- `schema_version`, `header` (subject, level, term, chapter, unit, week, `objective` in NERDC wording verbatim, stage, theme).
- `sections[]`: `{id, type, layer CORE|ENRICH|CORE+, heading, lang, blocks[], tutor_script, audio_refs}`.
  - Lesson section types: story_opener, concept (repeatable), worked_examples, across_subjects, window_to_world, practice, do_and_discover, tell_it_back, remember, think_deeper, quick_fire, character_values, mastery_check.
  - Blocks: paragraph, bullets, definition, example, dialogue, illustration `{asset_id | brief, alt}`, callout, activity_steps, table, question.
  - Question kinds: mcq, fill_blank, match, circle, sort, tap_image, speak, draw (all auto-gradable offline), plus `free_text`/`spoken` graded online.
- **Stable IDs:** section and question IDs are assigned server-side and are stable across versions. Revision patches are ID-addressed, and a lint rule fails any version that drops or regenerates IDs (protects `unit_questions`, spaced practice and item analysis).
- `session_plan[]`: splits a week-unit across the week's periods in the one-hour shape (Start 10 → Teach 15 → Move & Do 15 → Practice 10 → Close 10).
- `workbook`: Tier 1/2/3, 60-second quick-answer drill, Take It Home, answers, Not-yet remediation, and a **pre-generated practice-variant pool** (reviewed with the unit; "more practice" draws from this pool).
- `teacher_manual`: script, theme map and connection moment, timing, materials, mastery guidance, helper script.
- **Evolution:** `schema_version` on every record; the manifest carries `min_app_version`; the server serves the highest compatible pack; the renderer degrades gracefully on unknown block types; pure `migrate_vN` functions with golden fixtures. Unicode NFC normalisation for Yoruba/Igbo/Hausa, and a bundled font with tone-mark support.
- **Freeze test:** the schema is not frozen until it validates the golden Basic Science unit **and** a P1 Mathematics unit (hand-built from the brief's "Market Day" theme) **and** one project unit, so it does not overfit one example.

**Publish gate (lint, Brief §17):**

- **Errors:** required sections present; 2–3 enrichment sections; objective present; workbook tiered with answers; teacher manual present; IDs preserved.
- **Warnings:** Think Deeper rung matches the stage; enrichment rotation varies; Nigerian anchor and global window; timing fits 60 minutes.
- **Claude-judged:** religious neutrality, reading level, factual sanity. Advisory for the human reviewer; **a human always approves**. The review UI renders every field the tutor will consume (tutor_script, alt text, helper script), so hidden text in a source PDF cannot reach children unseen.

## 5. Claude integration (Edge Functions)

Models per task in `app_settings`: authoring = `claude-opus-5-5`, tutor = `claude-sonnet-5-5`, classification/moderation = `claude-haiku-5-5`.

**Every call:** structured outputs (`output_config.format` / `messages.parse`) with **per-section schemas** (a single giant union risks decoding-schema limits, so each section is parsed separately, then the full unit is Zod-parsed and linted); adaptive thinking with `effort` set **explicitly**; no prefill or forced `tool_choice` (rejected by these models); streaming for long calls; server-side refusal fallback and handling of `stop_reason: "refusal"`; prompt caching (brief rules + cast bible + schema as the stable prefix, unit context last); every call logged to `ai_usage`; global kill switch; per-user/per-child daily budgets. Re-read the SDK docs for exact syntax at implementation time.

| Function           | Purpose                                                                                                                                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ai-scheme-ingest` | Admin uploads a scheme (PDF via native document input; docx/text). Extracts to `schemes`/`scheme_weeks` as an **editable draft**.                                                                                                                                  |
| `ai-chapter-plan`  | Groups teaching weeks into 3–5-unit chapters; proposes cross-subject themes per term (subject leads, theme serves).                                                                                                                                                |
| `ai-unit-generate` | Outline pass → sections → workbook → teacher manual → tutor_script → practice variants → **coherence pass**. Inputs: objective, stage, theme, cast, prior units (for Remember?), previous enrichment trio (to rotate). Output: draft `unit_version` + lint report. |
| `ai-unit-revise`   | Admin chat per unit ("shorten the opener"); returns an ID-addressed patch → new version.                                                                                                                                                                           |
| `ai-illustration`  | Illustration briefs; Claude-authored SVG for simple diagrams; raster provider pluggable (deferred); admin can always upload.                                                                                                                                       |
| `tutor-chat`       | SSE streaming (see below).                                                                                                                                                                                                                                         |
| `ai-assess`        | Grades free-text/spoken answers; returns a **bounded structured verdict** only (advisory).                                                                                                                                                                         |
| `ai-batch-*`       | Whole-term pre-drafting via the Message Batches API (50% cost).                                                                                                                                                                                                    |

On-demand worksheet generation is **not** in v1: "more practice" uses the reviewed variant pool. Free-text parent prompts never reach an authoring-grade model unreviewed.

**Job engine (Edge limits checked against current Supabase docs):** wall-clock 150 s Free / 400 s Paid, 2 s CPU per request (async I/O excluded), 256 MB memory, 150 s idle timeout (504), 20 MB bundle, no `sharp`/libvips, outbound function-to-function calls rate-limited.

- **Production needs a Paid Supabase plan.**
- Jobs are a **`pgmq` state machine**: visibility timeout, lease + heartbeat, idempotency key `(unit, step, input_hash)`, raw responses stored, retry cap, `retry-after` handling. `pg_net` triggers a worker that returns 202 and does one step (one Claude call) per invocation, then re-queues; a killed worker (status 546) resumes, not restarts. `beforeunload` saves progress. The admin UI follows progress via Realtime.
- Keep CPU low (validate with Zod once per step). Pack building (compression) is a Node script/GitHub Action on publish, not an Edge Function.
- **Publish is an idempotent job** (build pack → upload → project `unit_questions` → flip `published_units` pointer **last**), with `base_version_id` optimistic concurrency against concurrent admin edits.

**Tutor design (`tutor-chat`):**

- SSE piped inside `EdgeRuntime.waitUntil(...)` (otherwise the isolate is retired mid-stream). The client uses `expo/fetch` streaming. Each turn is persisted server-side with a client turn UUID, so a dropped 3G stream is recovered by refetching the completed turn.
- Verifies the guardian JWT + `child_id` against household access. System prompt = persona (cast), unit grounding (objective, key facts, what to teach next), stage language, pre-reader brevity, plain text only (TTS-friendly). Effort `low`, windowed/summarised history.
- Hard rules: stay on the unit and age-appropriate; never ask for personal data; redirect unsafe/off-topic input.
- **Input is redacted for PII (Nigerian phone formats, emails, addresses) before the Claude call and before storage.** The child's real name/photo is never sent; a chosen alias is used.
- The moderation classifier runs **in parallel** with the tutor call (not serially before it) and can cancel/replace a reply.
- Tools (`auto`): `record_mastery_evidence`, `show_activity`, `give_hint`. **Tutor evidence is advisory only.** Mastery is granted solely by deterministic grading of the `mastery_check`; tool arguments are validated against the pack; links/HTML stripped from output.
- **Safeguarding protocol (written and reviewed before tutor-chat ships):** self-harm and abuse disclosures get a safe, supportive in-chat response and go to a **CUSTAR safeguarding reviewer queue** (`safeguarding_cases`, human, with an SLA), **not an automatic notice to the household**, since the risk can be inside the household. Flagged transcripts are withheld from guardians until a reviewer decides. Non-sensitive flags (off-topic, mild) are guardian-visible.

**Rough cost (re-baselined, measure with `ai_usage`):**

- Authoring (Opus 5.5, all-in with thinking, section re-reads, revisions and lint retries): about **$1–3 per unit**, so roughly $1.5–4k for all 6 levels × 8 subjects, about half via Batches.
- Tutoring (Sonnet 5.5): about **$0.005–0.01 per turn**, so $4–9 per child per month at 30 turns a day. Daily turn budgets, low effort and windowed history keep this bounded. Compute unit economics in naira against the subscription price before launch.

## 6. Offline architecture (learner app, native)

- **Local-first.** `expo-sqlite` (WAL; `withExclusiveTransactionAsync`; `PRAGMA user_version` migrations) is the read model. The UI reads SQLite; the network only syncs.
- **Packs.** Per published unit: an **immutable manifest** plus **content-addressed media files**; JSON stored uncompressed (HTTP compression handles transport, avoiding a JS-thread unzip on low-end phones). Two packs: a **learner pack** (content, tutor_script, answers needed for offline grading) and a smaller **grown-up pack** (teacher manual, helper script). Atomic manifest swap; the previous pack stays until the current session ends, so question IDs never change under a child.
- **Download manager.** Per-file state in SQLite, re-signs URLs on resume, survives Android process death, checks free disk first, partial-file recovery, Wi-Fi-only toggle, storage meter, delete, background update.
- **Works fully offline:** reading, pre-generated narration, auto-graded exercises, quick-fire, mastery check, notebook, **Tutor Lite** (scripted dialogue from the pack; **per-question-type matching with numeric normalisation and no edit distance on numbers**, so "12" never matches "21" and "1/2" matches "0.5"). Free-form Claude chat resumes online.
- **Sync.** Outbox batches go through a **batch RPC** with per-row results, a size cap and a dead-letter after N attempts, so one poison row never blocks the queue. Pull uses `sync_seq` cursors plus tombstones, and a membership-epoch full resync when access changes. Events are append-only, so there are no merge conflicts; profile edits use last-write-wins on server time.
- **Web.** The learner app on web is for grown-ups (worksheets, reports) only. Offline learning is native-only.

## 7. Voice (framework now, providers later)

- Interfaces in `apps/learner/src/voice`: `SpeechSynthesizer`, `SpeechRecognizer`, behind a `TutorChannel` (input text|voice, output text|speech). Voice turns are **audio → transcript(+confidence) → the same tutor pipeline**, so the server only sees text plus `input_mode`.
- Text-first milestones ship `expo-speech` read-aloud and a no-op recognizer. `reading_mode = pre_reader` already drives the UI (big picture buttons, auto-play narration, mic button).
- Later: pre-generated cloud-TTS narration cached in packs (best offline), and STT via on-device (`expo-speech-recognition`, dev build) or a cloud provider through an edge function. Risks: child speech, Nigerian accents, Yoruba/Igbo/Hausa support. Provider choice **deferred**.

## 8. Privacy, consent and compliance (starts in M0, not M6)

- `consents` table (version, scope, timestamp, withdrawal) in the first migration; **tutor-chat ships only behind the consent gate.**
- Retention and deletion design up front: per-table retention periods and purge jobs, and deletion that handles append-only events, storage objects and backups (crypto-shredding or scheduled purge).
- Cross-border transfer disclosure (Supabase eu-west-1, Anthropic US). Verify the Anthropic data-retention/DPA position. Track NDPC registration, DPO and DPIA obligations in a legal checklist that runs in parallel from M0.
- Google Play **Families** policy likely applies to a children's app. It constrains analytics/crash SDKs, advertising IDs and the parental gate. Check before choosing any third-party SDK.
- Custom SMTP for email OTP (Supabase's built-in mailer is heavily rate-limited).

## 9. Features

**Learner area (child):** profile picker; home with today's lesson, this week's **theme card**, streak/stars; lesson player rendering section cards in the Start→Teach→Move & Do→Practice→Close shape with movement prompts; **mastery-gated unlocking**; tutor panel (text now, voice-ready); notebook; exercise engine; Quick-fire mini-games; 8 core subjects, electives/extra-curricular (global curriculum, same engine); mini and end-of-term projects as unit kinds. The NERDC objective box is visibly dominant, with CORE/ENRICH badges for grown-ups (Brief §3.1).

**Grown-ups area (guardian/tutor, PIN-elevated):** child profiles and settings; progress and mastery per subject/unit; transcripts; Take-It-Home tasks; downloadable/printable worksheets (`expo-print` → PDF, offline-capable); tutor invitations and per-child grants; helper-mode launcher.

**Admin area:** users and households; subject creation; scheme ingestion; chapter planner; unit workspace (AI generate, chat-revise, diff, preview with the exact learner renderer, lint panel, review → approve → publish); workbook/teacher-manual export; NERDC coverage heat-map; dashboard (usage, mastery, drop-off, item analysis, AI cost); access management (RBAC + MFA); communications; support inbox; safeguarding queue; audit log.

**Seeded core subjects (assumption, editable data):** English Studies, Mathematics, Basic Science, Social Studies, Civic Education (National Values), Cultural & Creative Arts, Nigerian Language (Yoruba/Igbo/Hausa), Physical & Health Education. Religion studies, ICT, Pre-vocational Studies and French/Arabic start as electives (fits the religiously-neutral spine).

### Feature recommendations (beyond the brief)

1. **Spaced "Remember?" engine** (Leitner scheduling over `unit_questions`): makes the brief's spiral automatic.
2. **Adaptive remediation:** a failed mastery check serves a targeted re-teach from the reviewed variant pool (the static "Not yet?" box becomes dynamic).
3. **Data-saver mode:** small packs, optional audio, WebP images, Wi-Fi-only downloads. Data cost is a real adoption barrier; download-on-Wi-Fi/use-anywhere is the killer feature.
4. **Weekly parent digest** (push and a WhatsApp-shareable card): what was learned, "talk about it at dinner" prompts, Take-It-Home tasks.
5. **Cross-subject Theme Week view** with the brief's two-minute Connection Moment.
6. **Diagnostic placement test** per subject; skip-ahead through mastery.
7. **Calm gamification:** stars, streaks, collectible Zari & Zuri stickers; no leaderboards between children; daily time limits and quiet hours.
8. **Accessibility:** read-along highlighting, dyslexia-friendly font option, high contrast.
9. **Term report and certificate PDFs**; exam-readiness views mapped to scheme coverage.
10. **Authoring quality tools:** coverage heat-map, Claude-judged neutrality/reading-level lint, prompt versioning and golden-unit evals.
11. **Mother-tongue support** (NERDC policy for lower primary): Nigerian-language read-aloud and bilingual key terms.
12. **Printables:** flashcards from Quick-fire, colouring pages, certificates.
13. **Billing-ready:** `entitlements` + Google Play Billing (required for digital goods on Android), later Paystack/Flutterwave.

## 10. Roadmap (revised after review: smaller M0, offline de-risked early)

| Milestone                                                                                       | Scope                                                                                                                                                                                                                                                                                                                                                                                                                           | Exit criteria                                                                                                              |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **M0 Foundation** (build first, verifiable in this sandbox)                                     | Monorepo scaffold, CLAUDE.md, CI; ADRs (auth scope/elevation, sync, pack format); `design-tokens`; `content-schema` + lint + `migrate_vN` scaffolding with **three fixtures** (golden Unit 2, a P1 Maths unit, a project unit); P1 Basic Science scheme parsed to a fixture; **minimal migrations** (identity, consents, curriculum, `published_units`, RLS helpers) + pgTAP tests; `lesson-renderer` rendering the golden unit | typecheck/lint/test green; all fixtures validate; RLS tests pass; advisors clean; web export of the renderer screenshotted |
| **M1 Walking skeleton (learner, local-first)**                                                  | Email-OTP auth, child profiles, PIN elevation, hand-authored golden unit → publish job → pack → download manager → offline play → deterministic mastery gate → event sync                                                                                                                                                                                                                                                       | A real budget Android phone completes the unit in airplane mode and the events sync. Needs your device + Expo/EAS account. |
| **M2 Content engine (admin + Claude)** (parallel with M1 once the API key and cast bible exist) | Admin auth + MFA/RBAC, scheme ingest, chapter planner, job engine, unit generate/revise, lint, review/publish, preview                                                                                                                                                                                                                                                                                                          | P1 Basic Science Term 1 (weeks 1–4, 7–10 = 8 units) drafted by Claude, human-reviewed, published                           |
| **M3 Tutor (online text) + helper mode**                                                        | Safeguarding protocol, consent gate, redaction, `tutor-chat` SSE, Tutor Lite scripts, helper mode, TTS read-aloud, worksheets printing                                                                                                                                                                                                                                                                                          | Adversarial tutor test suite passes; a child completes a unit with the tutor                                               |
| **M4 Families**                                                                                 | Tutor role + per-child grants, notifications, parent dashboard, digests                                                                                                                                                                                                                                                                                                                                                         | Tutor reviews a notebook; guardian gets a digest                                                                           |
| **M5 Voice**                                                                                    | STT/TTS providers, pre-gen narration in packs, voice loop                                                                                                                                                                                                                                                                                                                                                                       | A non-reader completes a lesson by voice                                                                                   |
| **M6 Breadth**                                                                                  | Projects, electives, assessments, analytics, communications and support                                                                                                                                                                                                                                                                                                                                                         | All 8 subjects' schemes ingested; analytics live                                                                           |
| **M7 Launch**                                                                                   | Security review, NDPA/Play Families checks, accessibility, store assets, billing, load/cost tests, separate production project                                                                                                                                                                                                                                                                                                  | Store-ready builds                                                                                                         |

## 11. M0: what I will build first

1. **Scaffold:** npm workspaces; TS base config; ESLint (incl. peerDependency rule) + Prettier; Vitest; `.gitignore`; GitHub Actions (typecheck, lint, test, `supabase test db`, vendor-drift check); `CLAUDE.md`; `docs/` with the brief converted to markdown and the reference PDFs.
2. **`packages/design-tokens`:** CORE teal / ENRICH amber palette and type scale from the template.
3. **`packages/content-schema`:** Zod schemas (`UnitContent` by kind, `Scheme`, `Question`, `TutorScript`), lint rules from §4 as pure functions, `schema_version` + migration scaffolding, tests for pass and fail cases, three fixtures (golden Unit 2 transcribed from the template; P1 Maths unit; project unit) and the P1 Basic Science scheme parsed from the PDF.
4. **Migrations (minimal):** identity/households/children/invites/consents/elevations, curriculum, `unit_versions` + `published_units`, RLS helper functions and policies, `sync_seq`, indexes. Written to `supabase/migrations/` and applied via the Supabase MCP; after each apply I run `list_migrations` and rename the local file to the assigned version so git and the database cannot drift. pgTAP tests cover: guardian A cannot read household B; a tutor sees only granted children; no self-join; drafts invisible to non-admins; admin policies reject `aal1`. Then `get_advisors` and generated types into `packages/supabase`.
5. **Seeds:** levels P1–P6, 8 core subjects, Zari & Zuri (stub), P1 Basic Science scheme, golden Unit 2 as a published unit.
6. **ADRs:** guardian-token/elevation model; sync protocol (`sync_seq`, tombstones, epochs); pack format; job engine.
7. **`packages/lesson-renderer`:** renders the golden Unit 2 (and the Maths and project fixtures) in a web export, screenshotted with Playwright to prove one renderer will serve both apps.

M0 needs **no Anthropic key**. Live-AI work (ingest, generate) starts in M2. Commits go to `claude/vigilant-goldberg-qshyvy`. No PR unless you ask.

## 12. Verification

- **Static:** `typecheck`, `lint`, `test` in CI. Vitest for schema/lint/migrations and the sync/matching logic. Local SQLite tests use a different engine than expo-sqlite, so on-device behaviour (WAL, exclusive transactions, process death) is verified on a real budget Android from M1.
- **Database:** pgTAP RLS suite in CI (`supabase test db`) is the gate; MCP `execute_sql` role-impersonation is for ad-hoc checks only. `get_advisors` clean; regenerated types produce no diff.
- **Edge functions:** Deno tests with an injected mock Anthropic client (schema validity, refusal handling, usage logging, kill switch, job idempotency/resume); a manually-run live test on the supplied P1 Basic Science PDF; generated Unit 2 is compared against the golden fixture via the lint report.
- **UI:** `npx expo export --platform web` for both apps with Playwright screenshots (Chromium is pre-installed). This sandbox has no device or emulator, so native/offline flows need your phone (Expo Go supports `expo-sqlite`/`expo-file-system`; dev builds via EAS for anything else).
- **AI quality:** golden-unit eval (checklist grading) before any prompt change; **adversarial tutor suite** (off-topic, PII requests, self-harm/abuse phrasing, jailbreaks, "mark this correct") with expected redirects and safeguarding routing.
- **Environments:** this CUSTAR Tutor project is **dev** until real families onboard. A separate production project (and ideally staging) is created before M3/M7, with your approval since it costs money.

## 13. Prerequisites and open items

- **`ANTHROPIC_API_KEY`** as an Edge Function secret (Supabase dashboard; I won't ask you to paste it in chat). Needed from M2.
- **Expo account + a budget Android phone** for M1 device testing and EAS builds.
- **Character bible:** only Zari and Zuri are known from the template. I need traits/voices and any other cast, which the brief says must be provided and not guessed. Also **name subject-matter reviewers** for human sign-off of AI-drafted units.
- **Name the human safeguarding reviewer/owner and SLA** before tutor-chat ships.
- Confirm the **8 core subjects** list in §9.
- **Custom SMTP** provider for email OTP; **paid Supabase plan** before production; legal checklist owner (NDPC, DPO/DPIA, Anthropic DPA).
- **Deferred decisions:** TTS/STT providers, raster image generation provider, billing, Nigerian-language content approach.
- **Risks:** AI content accuracy for children (mitigated by mandatory human review; AI never auto-publishes, and child-facing "more practice" uses reviewed pools); Edge Function time limits (mitigated by the queue/step design); child-speech STT accuracy; low-end Android performance (avoid heavy animation, test on a budget device from M1); the scheme PDF has a third-party watermark, so keep it as a fixture only in a private repo.
