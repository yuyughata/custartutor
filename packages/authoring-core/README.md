# @custar/authoring-core

The content engine behind M2: Claude drafts scheme extractions, chapter plans and lesson units; a human reviews them
(CLAUDE.md rule 2: AI never auto-publishes). Pure TypeScript with no React, Expo, Supabase or Anthropic SDK imports.
Everything that touches the outside world is injected, so the same code runs in a Deno edge function, in the admin
app's browser demo mode, in Node scripts and in Vitest.

```
 admin app / script                        edge function `ai-job`                       Anthropic
 ------------------                        ----------------------                       ---------
 runJob(api, id)  --- step ------------->  JobEngine.runStep(kind, input, state, step)
   (src/client)    <-- 202 + the row ---     |  prompts + schemas + lint     (src/engine, src/prompts)
        |                                    v
        +-- get (poll the row) ----------  LlmClient.generate(request) ----------------> messages API
                                              (src/llm: createAnthropicLlm)
 demo mode / tests: createInMemoryJobApi + FakeLlm / demo model  (src/fakes) replace the right-hand side
```

| Import                                                | Contains                                                                                   | Platform |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------- |
| `@custar/authoring-core`                              | the contract, the Anthropic adapter, the step engine, the client job driver                | neutral  |
| `@custar/authoring-core/fakes`                        | `FakeLlm`, the fixture-backed demo model, `createInMemoryJobApi` (never in the main entry) | neutral  |
| `supabase/functions/_shared/vendor/authoring-core.js` | the main entry bundled for Deno (`node scripts/vendor-authoring.mjs`)                      | Deno     |

`src/purity.test.ts` fails the build if a shipped file imports a Node built-in, React, Expo, Supabase or the
Anthropic SDK, reads `process.env`, logs, or names a key. Test files may use Node.

## The contract (`src/contract.ts`)

One file, pure types and Zod schemas, is the single source of truth for everything that crosses a boundary. Change it
only together with the engine, the `ai-job` edge function and the admin app.

| Section | What it fixes                                                                                                                                                      |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1       | The **model port**: `LlmClient.generate(LlmRequest) -> LlmResult`, `LlmError` (`refusal`, `schema`, `truncated`, `transport`, `aborted`), `LlmModels`, efforts     |
| 2       | `AiSettings` (models, kill switch, budgets, prices, effort overrides, prompt version), `UsageRecord`, `estimateCostUsd` (no price entered = `null`, never a guess) |
| 3       | The cast bible (`CastTraits`, `OWNER_CAST_FACTS`): only owner-supplied facts are facts                                                                             |
| 4       | Job kinds, params (what the client sends), inputs (what the engine gets), results (what the engine returns and what the row stores)                                |
| 5       | The **step engine** interface: `parseInput`, `nextStep`, `progress`, `runStep`; `StepError`, `StepDeps`                                                            |
| 6       | The **job row** and the `ai-job` protocol (`create`, `step`, `cancel`), `JobApi`, `MAX_STEP_ATTEMPTS`, `STEP_LEASE_SECONDS`                                        |

Jobs are client-driven (ADR 0007): a job is a row plus a list of steps; each `step` request runs exactly one model
call (or a short deterministic step) and stores its output; the client polls the row and asks for the next step.
A step that dies leaves a lease that expires; the next `step` re-runs it, and a late finisher whose lease token no
longer matches is ignored.

## The model port, Anthropic side (`src/llm`)

```ts
import Anthropic from 'npm:@anthropic-ai/sdk'; // Deno; in Node: import Anthropic from '@anthropic-ai/sdk'
import { createAnthropicLlm } from '@custar/authoring-core';

const llm = createAnthropicLlm({
  client: new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY') }), // the key lives only in the function secret
  models: settings.models, // { authoring, tutor, moderation }: the id comes from request.task
  timeoutMs: 120_000, // keep one call inside the step's lease
  maxRetries: 1, // the SDK retries 429/5xx itself; the engine also retries a failed step
});
```

`AnthropicLike` is a structural slice of the SDK client (`messages.create`, and `messages.stream(...).finalMessage()`),
so this package never imports the SDK. `src/llm/anthropic.sdk-compat.test.ts` proves at compile time that the SDK's
`Anthropic` is assignable to it, and drives the real SDK client against a stubbed `fetch` to check the request body, the
SSE parser and the error classes without a network.

### What each request becomes

| Rule (plan section 5)              | In the request                                                                                                                                                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Model per task                     | `model = models[request.task]`                                                                                                                                                                                                 |
| Structured outputs                 | `output_config.format = { type: 'json_schema', schema }`. The Zod schema is converted by `toStructuredJsonSchema` (below) and the reply is **always** re-validated with the original Zod schema                                |
| Adaptive thinking, explicit effort | `thinking: { type: 'adaptive' }`, `output_config.effort = request.effort`                                                                                                                                                      |
| No prefill, no forced tool choice  | A request whose last message is not `user` is a programmer error (`LlmRequestError`, nothing is sent). `tools`, `tool_choice`, `temperature`, `top_p`, `top_k` are never sent                                                  |
| Prompt caching                     | `system` blocks with `cache: true` get `cache_control: { type: 'ephemeral' }`. The API allows 4 breakpoints; if more are asked for, the **last** 4 are kept                                                                    |
| PDF input                          | `{ type: 'pdf' }` parts become base64 `document` blocks (`title` kept), in the order given                                                                                                                                     |
| Streaming                          | Above 21 333 `max_tokens` the request streams (`messages.stream().finalMessage()`), the SDK's own threshold for non-streaming calls. `streamAboveMaxTokens` changes it; a "Streaming is required" error falls back to a stream |
| Abort                              | `request.signal` goes to the SDK; an abort maps to `LlmError('aborted', retryable)`                                                                                                                                            |

### What each outcome becomes

| Outcome                                               | Result                                                                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `stop_reason: 'refusal'`                              | `LlmError('refusal')`, not retryable; the category is named in the message                              |
| `max_tokens`, `model_context_window_exceeded`         | `LlmError('truncated')`, not retryable as is; `raw` keeps what was written                              |
| Reply is not JSON, or fails the Zod schema            | `LlmError('schema', ..., { raw })`; the message names the schema and the failing paths, never the reply |
| HTTP 408, 429, 5xx (incl. 500, 502, 503, 529)         | `LlmError('transport', { retryable: true, status, retryAfterMs })`                                      |
| Any other HTTP status (400, 401, 403, 404, 413 ...)   | `LlmError('transport', { retryable: false, status })`                                                   |
| No HTTP response (network, DNS, the client's timeout) | `LlmError('transport', { retryable: true })`                                                            |
| The signal fired                                      | `LlmError('aborted', { retryable: true })`                                                              |

`retryAfterMs` comes from `retry-after-ms`, else `retry-after` (seconds or an HTTP date). Errors that follow an
answered (and therefore billed) call are `LlmCallError`s carrying `usage`, `model` and `stopReason`; use
`usageOfError(error)` so a refusal or a truncated reply still reaches `ai_usage` and the budgets. Messages contain the
status, the API's error type and message (cut at 300 characters) and the request id, never the prompt. The API key
lives in the injected client and is never read or logged here.

### Structured-output schemas (`toStructuredJsonSchema`)

`z.toJSONSchema(schema, { io: 'input', reused: 'ref' })`, then rewritten to the subset the API accepts: every object
gets `additionalProperties: false`; `oneOf` becomes `anyOf`; type lists (`["string","null"]`) become `anyOf`;
`enum`, `const` and the documented string formats are kept; constraints the API does not support (`minLength`,
`pattern`, `minimum`, `minItems` above 1, defaults ...) are folded into the `description`, so the model still sees them
while Zod enforces them. Single-use and tiny definitions are inlined. It **rejects loudly** (`LlmRequestError`, naming
the schema and the JSON pointer) what the API cannot express: records and catchalls, tuples, `z.unknown/any/custom`,
recursion, and a root that is not an object.

Consequence for the prompt builders: the lenient `Section`, `AnyBlock` and `UnitContent` of `@custar/content-schema`
(they carry `UnknownBlock.raw: z.unknown()`) and the sort question (`answer.mapping` is a record) cannot be sent as
they are. The engine must send strict, record-free variants and convert after the reply.

## Test doubles (`src/fakes`)

**`FakeLlm`** is a scripted `LlmClient`.

```ts
const llm = new FakeLlm()
  .on('unit_generate:outline', outline) // exact label
  .on(/^unit_generate:section:/, (request, call) => sectionFor(request)) // RegExp or predicate; a function computes the value
  .onSequence('flaky', [new LlmError('transport', 'blip'), value]) // each response once, in order
  .enqueue(a, b); // anything no handler claims, first in first out
```

A value is validated against `request.schema` (a bad script throws `FakeLlmScriptError`, it never reaches the engine
as a "model" reply); an `Error` is thrown, so script `LlmError`s to test refusals, truncation and retries; an
unscripted call throws `FakeLlmScriptError` naming the label. Every request is checked like the real adapter
checks it (`assertValidRequest`, and the conversion to the structured-output schema, `checkSchemas: false` turns the
latter off). `.calls` records label, task, system blocks, messages, schema name, effort, max tokens, signal, the JSON
Schema that would have been sent and the outcome. Usage is deterministic (`{ input: 100, output: 50 }` unless set with
`setUsage` or per handler); `reset()` clears everything.

**`createInMemoryJobApi`** is the ADR 0007 protocol in memory. It implements `JobApi` and adds `jobs()`, `usage()` and
`runStepsToCompletion(jobId)`.

```ts
const api = createInMemoryJobApi({
  engine, // the real JobEngine
  llm, // FakeLlm, the demo model, or a real client
  resolveInput, // JobInputResolver: params -> engine input
  settings: () => settings, // read before every step
  onSucceeded: async (job, result, input) => saveDraftAndReturnUnitDraftResult(...), // unit kinds
  stepDelayMs: 600, // so a UI shows progress
});
```

| Behaviour     | Detail                                                                                                                                                                                         |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create`      | Same idempotency key = same job. Rows are validated with the `JobRow` schema on every read and are copies                                                                                      |
| `step`        | Takes a lease of `STEP_LEASE_SECONDS` (injectable clock) and answers at once; `{ busy: true }` while a lease is held; the step runs in the background                                          |
| Retries       | A retryable `StepError` (or `LlmError`) increments `attempts` and the next `step` retries; `MAX_STEP_ATTEMPTS` failures, or any non-retryable one, fail the job with `{ code, message, step }` |
| Lease expiry  | An expired lease is taken over (the old step's signal is aborted); the old worker's late result is ignored (its token no longer matches), its usage is still logged                            |
| `cancel`      | Status `cancelled`, the step's signal fires, a late result is ignored                                                                                                                          |
| Kill switch   | `kill_switch: true` rejects `step` with `AiJobApiError` `code: 'kill_switch'`; finished jobs are unaffected                                                                                    |
| Budgets       | `budget_exceeded` when the job's (or today's, UTC) estimated spend reaches the cap. Cost is `estimateCostUsd`; a model with no price counts as unknown, not zero-and-hidden                    |
| `onSucceeded` | Turns the engine result into the stored `result`; a throw fails the job (its `code` property becomes the job error code), keeping the finished steps                                           |

The demo mode and the server tests are meant to run the same engine through this class, so a behaviour change in the
protocol belongs in `contract.ts`, the edge function and this file together.

## The client job driver (`src/client`)

```ts
const row = await createJobAndRun(
  api,
  'unit_generate',
  { unit_id },
  {
    idempotencyKey: `gen-${unit_id}-${attempt}`, // a double click makes one job
    onCreated: (job) => rememberJobId(job.id), // so a closed tab can resume
    onUpdate: (job) => render(job.progress, job.error),
    signal: controller.signal,
  },
);
// Later, after a reload:  await runJob(api, rememberedId, { onUpdate });
```

`runJob(api, jobId, options)` loops `get`; a finished job (`succeeded`, `failed`, `cancelled`) is returned, never
thrown. While a lease is held it waits `pollMs` (default 1500, floor 50) without asking for a step; otherwise it calls
`step`. Because the server hands the lease to one `step` request at a time, two loops (two tabs) on one job run each
step once.

| Option / error                | Behaviour                                                                                                                                 |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `onUpdate`                    | Called with the first row and whenever status, progress, attempts or the error change (not for lease timestamps)                          |
| `signal`                      | Stops waiting at once and rejects with `JobAbortedError` (`name: 'AbortError'`). The job is **not** cancelled; call `api.cancel` for that |
| Transient API errors          | A failed `get`/`step` is retried with exponential backoff (500 ms doubling, 30 s cap, 4 retries) and then rethrown                        |
| `AiJobApiError` with a `code` | Every protocol code except `internal` (`kill_switch`, `budget_exceeded`, `forbidden`, `mfa_required` ...) is permanent: rethrown at once  |
| `maxIdlePolls` (default 8)    | `JobStalledError` after this many consecutive step requests that changed nothing, for example a worker that keeps dying                   |
| `sleep`, `now`                | Injectable, so tests use a virtual clock; the default sleep is abortable                                                                  |

## Deno bundle

`node scripts/vendor-authoring.mjs` bundles `src/index.ts` (with `@custar/content-schema` and `zod` inlined, platform
neutral, no externals) to `supabase/functions/_shared/vendor/authoring-core.js`; `--check` fails when the committed file
is stale. The fakes are not part of it.

## Testing

`npx vitest run packages/authoring-core` is deterministic and offline: clocks and sleeps are injected, nothing opens a
socket. The model adapter is verified against the SDK's type definitions, against the real SDK with a stubbed `fetch`,
and against a recording fake client. **It has never been run against the live API** (that needs `ANTHROPIC_API_KEY`
and the opt-in evaluation script); what the service itself accepts, in particular the structured-output schema subset
and per-model support for adaptive thinking and `effort`, is unverified until the first live run.

<!-- engine section: M2.1b -->
