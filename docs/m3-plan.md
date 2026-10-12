# M3: Tutor (online text), Tutor Lite, helper mode, read-aloud, worksheets

Goal: a child completes a unit with the tutor, safely. Online, a text tutor grounded in the unit the child is playing;
offline, the unit's scripted Tutor Lite; with a human helper beside a pre-reader; with read-aloud and printable
worksheets for the grown-ups. The tutor is **off by default** and cannot be switched on without consent, a budget and a
named safeguarding owner (ADR 0008).

Contracts: [`packages/tutor-core/src/contract.ts`](../packages/tutor-core/src/contract.ts) (settings, safety, protocol,
pipeline, Tutor Lite, learner port) and `voice.ts`; ADR 0008; [safeguarding-protocol.md](safeguarding-protocol.md) and
[tutor-consent-draft.md](tutor-consent-draft.md) (drafts for the owner). Plan §5 (tutor design), §7 (voice), §8 (privacy).

## Work packages

| #    | Package                                                                                                                                                                                                | Where                                                             |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| M3.1 | `tutor-core`: redaction, deterministic safety patterns, the router, grounding and prompts, the turn pipeline, the Anthropic streaming adapter, Tutor Lite, the SSE codec, fakes, the adversarial suite | `packages/tutor-core`, `scripts/`                                 |
| M3.2 | Server: tables, gates, RPCs, safeguarding cases, retention purge, the `tutor-chat` edge function                                                                                                       | `supabase/`                                                       |
| M3.3 | Learner app: tutor panel and SSE client, consent gate, Tutor Lite runner, transcripts, helper mode, read-aloud, worksheet printing, demo stand-in                                                      | `apps/learner`, `packages/lesson-renderer` (read-aloud hook only) |
| M3.4 | Admin: safeguarding queue, tutor settings and the owner gate; integration of the real pipeline through the handler                                                                                     | `apps/admin` (after M2.4)                                         |

## The server surface (M3.2 builds, M3.3 and M3.4 call)

Same conventions as M2: `public.*` thin `SECURITY INVOKER` wrappers over `private.*` implementations; RLS on every
table; `anon` has nothing; column grants where it matters; service-role-only RPCs for the edge function's narrow writes.

**Tables.** `tutor_sessions(id, household_id, child_id, unit_id, version_no, model, prompt_version, started_at,
last_active_at, turn_count, flagged)`; `tutor_messages(id, session_id, household_id, child_id, client_turn_id (unique
per child), role child|tutor, input_mode, text (redacted only), redaction_count, status, safety jsonb, evidence jsonb,
show_activity jsonb, created_at)`, no client read path; `tutor_daily_usage(child_id, day, turns)`;
`safeguarding_cases(id, session_id, household_id, child_id, category, severity, status open|in_review|resolved,
excerpt jsonb (redacted), due_at, assigned_to, decision, notes, created_at, resolved_at)`. `ai_usage` gains a nullable
`tutor_session_id` and `job_id` becomes nullable (a tutor call has no job); usage rows carry tokens only, never text.
`admin_users.role` gains `safeguarding`. The `app_settings` key check is extended with `TUTOR_SETTING_KEYS`.

**RPCs.**

| Name                                                                                                                                                                                                                                          | Who                                                             | Does                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_tutor_consent(p_child_id) -> {granted, version, required_version}`                                                                                                                                                                       | guardian of the child                                           | The latest ledger row for scope `ai_tutor` decides.                                                                                         |
| `set_tutor_consent(p_child_id, p_action, p_version)`                                                                                                                                                                                          | guardian; **grant needs an elevation**                          | Appends a `consents` row (scope `ai_tutor`); withdraw needs no elevation.                                                                   |
| `list_tutor_sessions(p_child_id, p_limit)`                                                                                                                                                                                                    | guardian **+ elevation**                                        | `TutorSessionSummary[]`.                                                                                                                    |
| `get_tutor_transcript(p_session_id)`                                                                                                                                                                                                          | guardian **+ elevation**                                        | `TutorTranscriptMessage[]`; messages of cases that are not released are returned with `withheld: true` and a neutral placeholder text.      |
| `set_tutor_enabled(p_enabled)`                                                                                                                                                                                                                | `super_admin` at aal2                                           | Refuses to enable without a confirmed `safeguarding.owner` (`safeguarding_owner_required`). Audited.                                        |
| `list_safeguarding_cases(p_status)`, `get_safeguarding_case(p_id)`, `update_safeguarding_case(p_id, p_status, p_decision, p_notes)`                                                                                                           | `safeguarding`, `super_admin` at aal2                           | Every call writes an audit row. `get` returns the redacted excerpt. A decision `release` makes the held turns visible to the guardian.      |
| `tutor_get_settings()`, `tutor_reserve_turn(p_child_id, p_limit)`, `tutor_open_session(...)`, `tutor_save_turn(...)`, `tutor_open_case(...)`, `tutor_get_turn(p_child_id, p_client_turn_id)`, `tutor_log_usage(...)`, `tutor_purge_expired()` | `service_role` only (the edge function; the purge by `pg_cron`) | Atomic budget counter; idempotent turn save keyed by `(child_id, client_turn_id)`; purge of unflagged messages past `tutor.retention_days`. |

**Edge function `tutor-chat`.** Body and events are `TutorChatRequest` / `FetchTurnRequest` / `TutorStreamEvent` /
`TutorErrorBody`. It verifies the caller's JWT and that the child is in the caller's household, then applies the gates of
ADR 0008 in order, builds the grounding from the **published** unit (current snapshot or the requested version), loads the
cast, runs the `tutor-core` pipeline and streams SSE inside `EdgeRuntime.waitUntil`. It reads with the caller's JWT and
uses `service_role` only for the `tutor_*` RPCs, after the caller is authorised. CORS as `ai-job`.

## Learner app (M3.3)

- **Tutor panel** in the lesson player (online only): chat bubbles, streamed replies, the calm safety UI, a clear
  "this is a computer program" label, a retry that uses `fetch_turn`, the daily-limit and consent-required states.
  Offline, the panel offers **Tutor Lite** for the section the child is on.
- **Consent gate** in the grown-ups area (PIN elevation to grant): the consent text of
  [tutor-consent-draft.md](tutor-consent-draft.md), per child; withdraw any time.
- **Transcripts** in the grown-ups area (under elevation); withheld turns show a neutral placeholder.
- **Tutor Lite runner**: uses the pure engine of `tutor-core`; the state is persisted locally so a restart resumes.
- **Helper mode**: a launcher in the grown-ups area (a helper session for a child, no grown-up access), a lesson
  view with the unit's **helper script** (from the grown-up pack) beside the child's content, big picture buttons and
  auto-play narration for `pre_reader` children, and the helper can type the child's reply to the tutor.
- **Read-aloud**: the `SpeechSynthesizer` port with an `expo-speech` implementation and the no-op recognizer; a speaker
  button on sections and on tutor replies; a setting for speed. Voice input is not built (M5).
- **Worksheets**: printable PDFs of the unit's workbook (tiers, drill, take-it-home, with an answers sheet for the
  grown-up) through `expo-print` + `expo-sharing`, in the grown-ups area, offline-capable.
- **Demo mode**: an in-memory scripted stand-in implementing `TutorApi`, labelled "Demo tutor: not Claude" on every
  reply, so the flow can be tested and screenshotted without a backend.

## Admin (M3.4)

A safeguarding queue (list by status and severity with due times, a case view with the redacted excerpt, a decision
form), a Tutor section in Usage and settings (enabled switch with the owner gate, daily budget, retention, persona name,
safe-reply wording, helpline text, SLA targets), and tutor usage in the usage summary.

## What is and is not verified

Built and testable here: redaction, patterns, the router, the sanitiser, grounding (no mastery answers), the pipeline
and stream codec against a scripted model, Tutor Lite, the SQL (pgTAP and live-database checks), the handler with injected
dependencies, the learner screens in a browser in demo mode.

Not verifiable without a live key and your accounts: how the model behaves under attack (the adversarial suite has an
opt-in live run that needs `ANTHROPIC_API_KEY`), the deployed function, real streaming over mobile networks, and
anything about speech on a real device. **Human red-teaming and the owner's approval of the safeguarding protocol are
launch gates that no test replaces.**

## Prerequisites from you

1. A **named safeguarding owner** (and deputy) and a decision on the protocol (`docs/safeguarding-protocol.md`).
2. Review of the consent text and safe replies by a child-protection professional and Nigerian counsel.
3. Verified helpline numbers, if any are to be shown.
4. Anthropic's data-retention and cross-border position checked, then stated in the consent text.
5. The tutor persona's name, if it should have one.
