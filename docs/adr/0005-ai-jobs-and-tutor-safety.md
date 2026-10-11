# ADR 0005: AI job engine and tutor safety

Status: accepted (M0); implemented in M2 (authoring) and M3 (tutor)

## Context

Supabase Edge Functions have a 150 s (Free) or 400 s (Paid) wall-clock limit, 2 s CPU per request and 256 MB of
memory. Opus-grade unit generation with thinking cannot finish inside one invocation. The tutor talks to children
and must handle safeguarding disclosures, prompt injection and PII.

## Decision

**Jobs.** Generation runs as a `pgmq` state machine: visibility timeout, lease and heartbeat, idempotency key
`(unit, step, input_hash)`, raw responses stored, a retry cap and `retry-after` handling. `pg_net` triggers a worker
that returns 202 and does one step (one Claude call) per invocation, then re-queues. A killed worker resumes rather
than restarts. Each section has its own schema; the full unit is Zod-parsed and linted at the end, with an outline
pass first and a coherence pass last. Publish is its own idempotent job (ADR 0004). Production needs a Paid
Supabase plan.

**Authoring safety.** AI never auto-publishes. The review UI renders every field the tutor will consume
(tutor_script, alt text, helper script) so hidden text in a source PDF cannot reach children unseen. There is no
on-demand worksheet generation in v1: "more practice" draws from a reviewed variant pool made at authoring time.

**Tutor.** SSE is piped inside `EdgeRuntime.waitUntil(...)`, and the client streams with `expo/fetch`. Each turn
is persisted with a client turn UUID so a dropped stream is recovered by refetching. Input is redacted for PII
(Nigerian phone formats, emails, addresses) before the Claude call and before storage; the child's real name and
photo never reach Claude (alias only). A moderation classifier runs in parallel with the tutor call and can
replace the reply. Tutor tools are advisory: **mastery is granted only by deterministic grading** of the
`mastery_check`, and tool arguments are validated against the pack.

**Safeguarding.** Self-harm and abuse disclosures get a safe in-chat response and go to a CUSTAR safeguarding
reviewer queue (`safeguarding_cases`, human, with an SLA), not to an automatic notice to the household, because
the risk can be inside the household. Flagged transcripts are withheld from guardians until a reviewer decides.
This protocol and its named owner are required before `tutor-chat` ships, behind the consent gate.

## Consequences

More moving parts than a single synchronous call, but each step is short, resumable and auditable. Safeguarding
needs a human owner (a business decision, tracked as a prerequisite).
