# ADR 0008: The tutor: `tutor-chat`, safety routing and the gates that keep it off

Status: accepted (M3). Implements the tutor and safeguarding parts of ADR 0005.

## Context

The tutor talks to children. The risks are unlike authoring: a child can disclose harm, a child or a story can try to
push the model off its rules, personal data can be typed in, and the model can be wrong or say something unsuitable.
The guardian's session is on the child's device (ADR 0002), so authorisation is the guardian's JWT plus a check that
the child belongs to the guardian's household.

## Decision

**One edge function, `tutor-chat`, one turn per request, SSE for the reply.**
`POST {action:'turn', child_id, client_turn_id, session_id?, unit_id, version_no, section_id?, question_id?, input,
helper_present}`. The reply streams as SSE `data:` lines (`TutorStreamEvent`). The stream is piped inside
`EdgeRuntime.waitUntil(...)` so the isolate is not retired mid-stream. The turn is persisted server-side under the
client turn id, so a dropped 3G stream is recovered with `{action:'fetch_turn'}`, and a retry never creates a second
turn.

**Gates, in order, before any model is called** (each fails with a typed error and no model spend):
JWT; the child is the caller's; `tutor.enabled` (off by default, and `set_tutor_enabled` refuses until a named,
confirmed `safeguarding.owner` exists); the global kill switch; current consent for scope `ai_tutor` (a ledger row,
granted with a grown-up elevation); the per-child daily turn budget (an atomic counter); no other turn of the session
in flight.

**Redaction first, always.** The child's text is redacted (Nigerian phone formats, emails, URLs, street addresses,
long digit runs, supplied real names) before the classifier, before the tutor call and before storage. The raw text
exists only in memory. The child's alias is the only name the model sees.

**Safety routing is mostly deterministic and never improvises in a crisis.**
A Haiku classifier (structured output, `ModerationVerdict`) runs in parallel with the tutor call; deterministic
patterns for self-harm and abuse disclosure run beside it as a backstop (either one triggers). A pure router maps
verdict plus patterns to a `SafetyAction`:

| Signal                             | Action                                   | Reply                               | Case | Guardian sees the turn |
| ---------------------------------- | ---------------------------------------- | ----------------------------------- | ---- | ---------------------- |
| self_harm (any severity)           | `safe_reply`                             | fixed `self_harm` text              | yes  | withheld until review  |
| abuse_disclosure (any severity)    | `safe_reply`                             | fixed `abuse` text                  | yes  | withheld until review  |
| distress medium or high            | `safe_reply`                             | fixed `distress` text               | yes  | withheld until review  |
| sexual or violence, medium or high | `blocked`                                | fixed `blocked` text                | low  | visible                |
| jailbreak medium or high           | `redirect`                               | fixed `redirect` text               | no   | visible                |
| personal_info_shared               | `allow` (redacted), tutor reminds gently | model                               | no   | visible                |
| off_topic low or medium            | `steer`                                  | model, told to return to the lesson | no   | visible                |
| none                               | `allow`                                  | model                               | no   | visible                |

Tokens from the tutor call are **held back until the input verdict arrives** (the classifier is the faster call), so a
reply to a self-harm disclosure is never streamed. After the stream, the output is sanitised (links, HTML, markdown,
phone numbers, requests for personal data, length) and, when `tutor.output_check` is on, checked by a second Haiku
call; a failure sends `replace`. If the classifier itself fails, the turn fails closed: patterns decide, and anything
unclear gets the `redirect` reply rather than a model answer.

**Self-harm and abuse never reach the household automatically.** A case goes to the CUSTAR safeguarding queue
(`safeguarding_cases`, role `safeguarding` or `super_admin` at aal2, every read audited, redacted excerpts only). The
risk can be inside the household, so a reviewer, not the system, decides what the household is told. Flagged turns are
withheld from the guardian's transcript view until then.

**Evidence is advisory.** The tutor may call two non-forced tools: `show_activity {question_id}` (validated against the
pack; never a mastery-check question) and `record_evidence`. Evidence is stored on the message and nowhere else.
Mastery is granted only by the deterministic grading of the `mastery_check` on the device (CLAUDE.md rule 4). The
grounding given to the model leaves out every mastery-check answer.

**Offline: Tutor Lite.** The reviewed `tutor_script` of each section runs on the device with no model: nodes in order,
the child's reply graded by the referenced question or by the accepted answers with the same matching as
fill-in-the-blank, lines chosen by a cursor (no randomness) so a restart resumes exactly. Free-form chat needs the
network.

**Data.** Tutor messages store redacted text only, with a retention period (`tutor.retention_days`) enforced by a purge
job; flagged material follows its case. Guardians read transcripts only under a live elevation. Calls log tokens to
`ai_usage` without the text.

## Consequences

- The tutor cannot be switched on by accident: it needs an owner, consent and a budget.
- The crisis path has no model in it, so its wording is a human's (docs/safeguarding-protocol.md) and testable.
- Streaming is delayed by the classifier's latency (about a second); that is the price of never streaming an unsafe
  reply. The held tokens are discarded if the verdict says so.
- The adversarial suite can only prove the deterministic parts offline (redaction, patterns, routing, sanitising,
  gates); how the model behaves under attack is measured by the opt-in live run and by human red-teaming before launch.
