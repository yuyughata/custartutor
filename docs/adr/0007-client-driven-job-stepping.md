# ADR 0007: Client-driven job stepping for the content engine

Status: accepted (M2). Amends ADR 0005 for interactive authoring.

## Context

ADR 0005 chose a `pgmq` worker, triggered by `pg_net`, that does one Claude call per invocation and re-queues.
That design suits unattended bulk drafting (a whole term overnight, via the Batches API). Interactive authoring is
different: an admin presses "Draft this unit" and watches it. There the queue adds moving parts (extensions,
triggers, a webhook secret, visibility timeouts) for no benefit, because a person is in front of a browser tab that
can drive the job itself.

Limits that shape any design: an Edge Function request lives 150 s (Free) or 400 s (Paid) of wall clock, uses 2 s of
CPU (waiting on the network does not count) and 256 MB. One Opus call with thinking can take a minute or two. A unit
needs a dozen calls.

## Decision

**A job is a row (`ai_jobs`) plus a list of steps; each step is one request/response of the `ai-job` edge function.**
The admin app (or `runJob` from `@custar/authoring-core`) drives it:

1. `create` inserts the row. The server resolves the client's ids into a full engine input (it reads the database
   with the caller's JWT) and stores it on the row.
2. `step` takes a **lease** on the row (`lease_until`, 150 s), answers `202` at once and runs the step in
   `EdgeRuntime.waitUntil(...)`: one model call (or a short deterministic step), then it stores the step output in
   `ai_jobs.state`, the usage in `ai_usage`, the progress in `ai_jobs.progress` and releases the lease.
3. The client polls the row (cheap: `state` and `input` are not readable) and calls `step` again when no lease is
   held and the job is not finished.
4. A step that dies (worker killed, timeout) leaves a lease that expires. The next `step` call re-runs it. Steps are
   idempotent for the same `(input, state)`; a step's output is stored only if its lease is still the caller's, so a
   late finisher cannot overwrite a newer attempt.

The step list is **dynamic**: the engine's `nextStep(kind, input, state)` decides, so a unit job runs one step per
section the outline planned. Failures are typed: transient ones (rate limits, overload, timeouts) are retried up to
three times per step, refusals and schema failures are not retried blindly (a schema failure gets one repair retry
inside the step), and a job that fails keeps its completed steps so it can be inspected.

AI never auto-publishes: the only things a job writes on its own are **draft** `unit_versions` (admin-only, never
visible to learners). Scheme extractions and chapter plans stay in the job row until a human applies them with an
explicit action.

Cost control: a global kill switch, a per-job and a daily cap (both in `app_settings`), usage logged per call.
Prices are entered by the owner, never hard-coded, so an unknown price is shown as "unknown" rather than wrong.

## Alternatives considered

- **`pgmq` + `pg_net` worker (ADR 0005).** Kept for later bulk drafting through the Batches API, where nobody is
  watching. Not needed for interactive use and harder to test without a local Supabase stack.
- **One long request with streaming.** Breaks on the wall-clock limit and on a closed laptop.
- **A separate worker host.** Another thing to run and secure.

## Consequences

- The browser tab must stay open for a job to progress. Closing it pauses the job; re-opening resumes it.
- Everything the steps need (prompts, schemas, validation, lint) lives in one pure package that runs in Deno, Node
  and the browser, so the demo mode and the tests exercise the real engine with a fake model.
- Production needs a Paid Supabase plan for the 400 s limit; 150 s per step is enough in practice because no step
  makes more than one long call.
