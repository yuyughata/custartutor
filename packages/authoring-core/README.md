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

## Engine and prompts (`src/engine`, `src/prompts`, `src/fakes/demoLlm.ts`)

```ts
import {
  createJobEngine,
  PROMPT_VERSION,
  DEFAULT_CAST,
  diffUnits,
  applyUnitPatch,
} from '@custar/authoring-core';

const engine = createJobEngine();
const input = engine.parseInput('unit_generate', rawInput); // StepError('input', 'invalid_input') when it does not fit
const step = engine.nextStep('unit_generate', input, state); // dynamic: reads earlier outputs
const outcome = await engine.runStep({ kind: 'unit_generate', input, state, step }, deps); // at most one model call
```

Also exported: `DEFAULT_CAST` (Zari and Zuri: the owner's facts plus guidance derived from age only, labelled as
such), `diffUnits(a, b)` (which sections and questions are new or changed, which were removed, whether the workbook,
manual, session plan or header changed), `applyUnitPatch(base, patch, { restrictTo })`, `restoreDroppedIds(base, next)`,
`assembleUnit(input, parts)`, `normalizeCast`, `DEFAULT_EFFORT` and `MAX_OUTPUT_TOKENS` (the per-step defaults, shown in
the admin Usage screen). The step names are the contract with the UI.

### Steps per kind

| Kind            | Steps                                                                                                                                                                                                                                                 | Model calls                                            |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `scheme_ingest` | `extract` (the PDF read natively via `deps.loadUpload`, or the text), `check` (no call: Zod `Scheme`, week numbers, kinds, duplicates, gaps, empty topics, teaching-week count, verbatim check against a text source)                                 | 1                                                      |
| `chapter_plan`  | `group` (no call: `groupIntoChapters`), `title` (titles, drafted objectives, stage, optional theme; a reply that moves a week is rejected)                                                                                                            | 1                                                      |
| `unit_generate` | lesson: `outline`, `section:<id>` per planned section, `workbook`, `manual`, `assemble` (no call), `repair:1`, `repair:2` (only when lint has errors), `review`. Other kinds: `draft`, `assemble`, (`repair:n` for revision and assessment), `review` | 4 + one per section (about 18 for a 14-section lesson) |
| `unit_revise`   | `patch` (an ID-addressed patch), `apply` (no call: apply, parse, lint, `lintVersionIds`, `changed`), `review` (changed parts only; no call when nothing changed)                                                                                      | 1 or 2                                                 |

`progress()` follows the dynamic plan: before `outline` a lesson job reports 5 steps; once the outline is stored the
total includes one step per section, and a `repair:n` step appears only after an `assemble` with lint errors.
Every step reads only strictly earlier steps' outputs, so running it again with the same `(input, state)` gives the
same output. Outputs stored in `state.outputs` are final-shaped JSON (a built `Section` and its `Question`s, the
`StoredOutline`, the assembled unit plus its lint), never raw model replies.

### What the code decides, and what the model decides

- **Ids are assigned by code**: `concept_1`.., the type name for every other section, `q_<section>_<n>` for questions,
  `n_<k>` for tutor lines, `variant_a`.. for practice pools. The model links a question to the block or tutor line that
  uses it with a `ref` of its own, resolved by position, so re-running gives the same ids.
- **The outline is normalised, never trusted** (`engine/outline.ts`): 2 to 5 distinct enrichment types (the template's
  five by default for Primary 1), rotation away from `previous_enrichment` (a window to the world is the preferred swap-in),
  no Remember? when there is no earlier unit, at most 4 concepts, every scheme subtopic assigned to a concept, a session
  plan of exactly `unit.periods` one-hour periods with the mastery check last. Each adjustment is kept as a note and
  shown to the reviewer.
- **Every section is validated before it is stored** with the real Zod schemas (`engine/mapping.ts`): answer specs, blank
  counts, an auto-gradable mastery check, practice covering tiers 1 to 3, Think Deeper having prompts. A reply that fails
  gets one repair retry inside the step (the problems are listed, with paths); a second failure is `StepError('schema')`.
- **Deterministic text**: the manual's timing, the workbook's tiers, intro and answers note are built from the session
  plan and the questions, so they cannot disagree with them. The NERDC objective in the header is the input's, verbatim.
- **Advisory only**: Claude's review, a cast guard (a sentence that names a character next to a family or friendship word),
  and a tutor-script guard produce `Flag`s. They never block, fix or approve.

### Errors and usage

`LlmError('refusal')` becomes `StepError('refusal')` (not retryable), `'truncated'` becomes `'truncated'`, `'aborted'` becomes
`'aborted'`, `'transport'` becomes `'transport'` with `retryable` and `retryAfterMs` copied. A call the API answered and billed
(a refusal, a truncation, a bad reply: `LlmCallError`) is added to `StepError.usage`, and on a successful retry both calls are
in `StepOutcome.usage`, so budgets never undercount. Effort and `max_tokens` per step family are in `engine/settings.ts`;
`settings.effort["unit_generate:section"]` (and the other family keys) override the effort.

### Prompts (`src/prompts`)

- **System prefix** (`prompts/system.ts`): a pure function of the job kind and the cast. For units it is the role, the data-not-instructions
  rule, the non-negotiable rules of CLAUDE.md and the brief, stage and voice (with the lint's own limits), the one-hour shape, the
  authoring format, the cast bible and the golden Unit 2 as the worked example (about 10k tokens). It is one system block marked
  `cache: true` and is byte-identical across every call of every step of every unit with the same cast (a revision shares it too).
  Everything about the unit being written comes after the breakpoint, in the user message.
- **Uploaded text is data.** Anything that came from an upload (scheme text, topics, subtopics, the unit title and objective derived
  from them, and earlier model output built on them) is fenced between `<<<DOCUMENT_DATA name="..">>>` and `DOCUMENT_DATA>>>`, with
  `<`/`>` escaped so the fence cannot be closed from inside; trusted facts (stage, ids, counts, lint errors) go in `<context>` blocks.
  An administrator's revise instruction and unit notes are instructions but are scrubbed of e-mail addresses and phone numbers first.
- **Cast bible** (`prompts/cast.ts`): "Facts supplied by the owner" lists only owner-supplied facts; guidance derived from age sits under
  its own heading, labelled as derived and adjustable; explicit rules forbid inventing traits, backstory or any relationship between
  the characters (no sibling, cousin, friend, classmate, shared home or school) unless `relationship_note` says so.
- **The worked example** (`prompts/exemplar.ts`) is the golden unit in the authoring format. A test checks that every sentence of it
  occurs in `goldenUnit2`, and that every exemplar section passes the same validation the engine applies to a model reply.
- `PROMPT_VERSION` ('m2-v1') must be bumped when a prompt, an authoring schema or the mapping changes in a way that could change output.

### Authoring schemas (`prompts/schemas.ts`)

Each step returns a compact, flat shape that code maps to the final `UnitContent`. Rules: every property required (empty `""`/`[]`
when it does not apply), no unions (blocks and questions are one flat shape with a `type`/`kind` field), no records or tuples, no
`.int()`/`.min()`/`.max()`/regex (counts and ranges are re-checked in code), root always an object. Each converts with the adapter's
`toStructuredJsonSchema` (tested), and none uses `pattern`, `oneOf`, `minimum`/`maximum` or `minLength`/`maxLength`.

| Schema (`schemaName`) | Step                            | Size as sent to the API |
| --------------------- | ------------------------------- | ----------------------- |
| `scheme_extract`      | `extract`                       | about 0.8 KB            |
| `chapter_titles`      | `title`                         | about 0.8 KB            |
| `unit_outline`        | `outline`                       | about 1.5 KB            |
| `unit_section`        | `section:<id>`                  | about 2.4 KB            |
| `unit_workbook`       | `workbook`                      | about 1.7 KB            |
| `unit_manual`         | `manual`                        | about 1.1 KB            |
| `unit_review`         | `review`                        | about 0.4 KB            |
| `unit_repair`         | `repair:n`                      | about 2.5 KB            |
| `unit_project`        | `draft` (mini and term project) | about 1.1 KB            |
| `unit_test`           | `draft` (revision, assessment)  | about 2.1 KB            |
| `unit_patch`          | `patch`                         | about 3.8 KB            |

A sort question's mapping is written as `{left: item, right: category}` pairs, not a record. The authoring format cannot express
`tap_image`, `speak` or `spoken` questions; a revision leaves those untouched and says so.

### Revisions

The model returns a patch keyed by existing ids: whole-section replacements (heading, blocks, tutor script), question replacements
under their own ids or new questions with a new id and an owner section, new sections (a concept or an unused enrichment type, at
most 5 in all), workbook text and manual entries. It cannot delete or rename anything (ids are permanent). `apply` keeps everything the patch does not
mention byte for byte, keeps a picture and a language tag when a rewritten block says the same thing, detaches narration audio when the text changes,
regenerates the answers note when a workbook question changed, and puts back any id a faulty application dropped (`restoreDroppedIds`).
`changed` is `diffUnits(base, next)` restricted to section and question ids; workbook and manual changes are named in the summary.

### The demo model (`@custar/authoring-core/fakes`)

`createDemoLlm()` answers every engine step from fixtures (the P1 Basic Science scheme, the golden Unit 2 re-keyed to the requested section
ids and types, the market-day maths unit's window to the world, the colour-chart project) so the real engine, the real lint and the real parse
run end to end offline. It reports the model id `DEMO_MODEL_ID` (`demo-fixture-model`), its review says it is a demo, and a test checks
that every authored string it emits is a fixture's.

### Tests

`src/engine/*.test.ts`, `src/prompts/*.test.ts` and `src/fakes/demoLlm.test.ts` run every kind through the real engine with the demo
model or a scripted model (`test-support/testKit.ts`: sample inputs built from the fixtures, a job driver that serialises the state between
steps, a scripted `LlmClient`). They cover happy paths, idempotence of every step, resumability, the schema repair retry, each model failure,
the dynamic plan, outline repairs, revisions and ids, the injection fence, the cast rules, the cache-stable prefix and the absence of personal data.

### Live evaluation (`scripts/eval-live.mjs`)

`ANTHROPIC_API_KEY=... node packages/authoring-core/scripts/eval-live.mjs --out report.md` runs P1 Basic Science term 1 through
`scheme_ingest` (the reference PDF, compared with the fixture: exact topic and subtopic match rate), `chapter_plan` and `unit_generate`
for week 2 (lint, a checklist against the golden unit, reading level per section, usage totals), and writes the report and the unit JSON.
Without a key it prints `ANTHROPIC_API_KEY not set: nothing to evaluate` and exits 0. `--demo` runs the same flow on the demo model with no
network and labels the report DEMO. **It has never been run against the live API**, so every prompt decision above is untested against a real model.
