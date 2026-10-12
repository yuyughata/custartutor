# @custar/tutor-core

The pure TypeScript heart of the CUSTAR tutor (ADR 0008, `docs/m3-plan.md`): PII redaction, the deterministic safety
layer, the moderation classifier, grounding and prompts, the turn pipeline, the streaming Anthropic adapter, the
offline Tutor Lite engine and the SSE codec. No React, Expo, Supabase or SDK imports; it runs in Deno edge functions,
in Node and in the learner app. A child's safety is the point of this package.

| Entry point                 | For                                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------------------- |
| `@custar/tutor-core`        | the server: everything below (bundled for Deno by `scripts/vendor-tutor.mjs`)                         |
| `@custar/tutor-core/client` | the learner app: the contract, `voice`, Tutor Lite and the SSE codec. No model code (a test enforces) |
| `@custar/tutor-core/fakes`  | `ScriptedTutorLlm` and `createDemoTutorApi` (the learner's demo mode). Not in the main entry point    |

`src/contract.ts` and `src/voice.ts` are the contract; this package implements it and does not change it.

## How a turn is made safe

```
child text (RAW, memory only)
   |
   v  1. redactPii            names (known + introduced), phones, emails, links, addresses, long digit runs
   |        |                 -> child_text_redacted is the ONLY text any model or store sees
   |        v
   |     2. deterministic patterns (raw + redacted text): self-harm, abuse/neglect, strong distress
   |        |  forced? (self-harm/abuse any severity, distress medium+)
   |        |     yes -> fixed safe reply, NO MODEL CALLED AT ALL (the crisis path has no model in it)
   |        v     no
   +--> 3. in parallel:  moderation classifier (flat structured verdict)   tutor stream (tokens HELD)
            |                                                               |
            v                                                               |
         4. routeSafety(verdict | null, pattern hits)  == the ADR 0008 table |
            |  safe_reply / blocked / redirect -> abort the stream, send the fixed text from settings
            |  allow / steer                   -> release the held tokens   <+
            v
         5. stream sanitiser (a sentence at a time: no links, HTML, markdown, emoji, contact data, requests for
            personal data, "I am human", revealed rules, mastery-check answers, over-long replies)
            v
         6. whole-reply sanitise, then the output check (a second moderation-model call) -> `replace` on failure
            v
         7. tools validated against the grounding (show_activity: practice questions only), then `done`
```

Layers are independent on purpose: the patterns do not trust the classifier, the sanitiser does not trust the
tutor, and the fixed replies do not involve a model. A null classifier verdict **fails closed** (see below).

## Parts

- **`redact/`** `redactPii(text, { knownNames?, kinds? }) -> { text, count, kinds[] }`. Tokens `[phone] [email]
[link] [handle] [address] [name] [school] [number]`. Lesson content survives (sums, prices, years, dates,
  counting runs, round numbers; `redact.test.ts` has 100+ cases each way). It is a **net, not a guarantee**: see the
  list of what it cannot catch at the top of `redact/redact.ts`.
- **`safety/patterns*.ts`** the deterministic list (data in `patternData.ts`, matcher in `patterns.ts`). Text is
  normalised first (case, accents, apostrophes, punctuation, leetspeak, repeated letters, spaced-out letters).
  Hits carry an id, a category and a severity, never the child's words.
- **`safety/router.ts`** `routeSafety({ verdict, patternHits, settings, unclear? }) -> SafetyDecision`. Either the
  classifier **or** the patterns trigger; for each category the higher severity counts; action order `safe_reply >
blocked > redirect > steer > allow`. Null verdict: patterns decide, a distress hit counts as at least medium, a
  jailbreak-list hit redirects, and a message that is long, odd or unclear (`isUnclearMessage`) is redirected.
- **`safety/classifier.ts`** `classifyMessage(llm, input)`: one flat structured call (`ModerationVerdict`), effort
  `low`, 600 max tokens, the child's text fenced as DATA. Never throws; a billed failure still returns its usage.
- **`safety/sanitize.ts`, `streamSanitizer.ts`** `sanitizeReply` and `createStreamSanitizer`.
- **`prompt/`** `buildGrounding(unit, { versionNo, unitId, subjectName? })` (mastery check = prompts only, never
  answers), `buildMasteryGuard(unit)` (answers, for the sanitiser only), `buildTutorRequest`: a byte-identical cached
  prefix (persona, rules, cast, child profile, fenced unit data) then per-turn notes, windowed history, the message.
- **`pipeline/`** `runTutorTurn(deps, input) -> { events, outcome }`. Never throws or rejects.
- **`llm/anthropicStream.ts`** `createAnthropicTutorLlm({ client, models })`. **It has not been run against the live
  API.** It is tested against hand-written event sequences and against the real SDK with a stubbed `fetch`.
- **`stream/sse.ts`** `encodeSseEvent`, `createSseParser` (incremental, never throws, size cap).
- **`lite/`** `startLite`, `replyLite`, `hintLite`, `skipLite`: pure, deterministic, JSON state, never grants mastery.
- **`fakes/`** `ScriptedTutorLlm`, `createDemoTutorApi` (`isDemo: true`, model id `demo-scripted-tutor`, every reply
  starts "Demo tutor (not Claude):", real safety behaviour).
- **`evals/adversarial/`** 150+ cases, the deterministic reply checks, and the live-run script
  `scripts/eval-tutor-live.mjs`.

## Using the pipeline from the edge function

```ts
const run = runTutorTurn(
  { llm, tutorLlm, settings, now: () => new Date(), signal },
  {
    child: { alias, level_code, stage, reading_mode },
    grounding: buildGrounding(publishedUnit, { versionNo, unitId }),
    position,
    history /* redacted, oldest first */,
    message,
    helper_present,
    cast,
    known_names: guardianSuppliedNames,
    ids: { session_id, message_id }, // optional: emits `meta` first and puts message_id on `done`
    mastery_guard: buildMasteryGuard(publishedUnit), // optional but wanted: answers for the sanitiser only
  },
);
for await (const event of run.events) write(encodeSseEvent(event));
const outcome = await run.outcome; // persist child_text_redacted, reply_text, status, safety, usage, ...
```

`ids` and `mastery_guard` are additive fields of `TutorTurnRunInput` (declared here, not in `contract.ts`; see the
report to the lead). Statuses: a fixed safe reply is `safe_reply`; `blocked` and `redirect` actions are `blocked`;
a model reply that was replaced is `replaced`; an upstream failure is `failed` with an `error` event and no `done`.

## What is verified, and what is NOT

Verified offline (deterministic, 1,000+ tests): redaction tables both ways; every pattern against its own examples
and against harmless look-alikes; every row of the ADR 0008 table, end to end through the pipeline, with the held
tokens, the aborted stream, replacement, the fail-closed rules, tool validation, billed-failure usage and the claim
that raw child text appears in no prompt, event or outcome; the sanitiser against adversarial model outputs; the
SSE codec under random chunking; Tutor Lite on every script of the fixtures (right and wrong replies, state
serialised between calls); the client bundle's import graph.

**Not verified, and no test here can be:**

- how the live classifier rates real attacks, and how the tutor model behaves when attacked (the opt-in
  `eval-tutor-live.mjs` measures it, and **human red-teaming by people who are not the builders is a launch gate**);
- the streaming adapter against the real service, and real streaming over mobile networks;
- the patterns are **English plus a little Pidgin**. They will miss Yoruba, Igbo, Hausa, new slang and anything
  indirect ("everything is too much"). A quiet safeguarding queue is not proof that no child is at risk;
- redaction misses names it was not told and cannot be guessed (see the header of `redact/redact.ts`);
- sexual and graphic-violence content has **no pattern list at all**: only the classifier (and the output check)
  see it. The adversarial suite represents those cases by neutral descriptions plus a scripted verdict, so it proves
  the router and the fixed reply, not the classifier. Real text is left to human red-teaming and the owner's
  private case list, which is not committed;
- tone and suitability of replies: nothing here judges them.

Commands: `npx vitest run packages/tutor-core`, `npx tsc -p packages/tutor-core/tsconfig.json`,
`node packages/tutor-core/scripts/eval-tutor-live.mjs --demo` (offline harness check), and with a key
`ANTHROPIC_API_KEY=... node packages/tutor-core/scripts/eval-tutor-live.mjs --out report.md`.

## How the owner extends the pattern lists

`src/safety/patternData.ts` is data. Add an entry `{ id, category, severity, template, examples }`:
`template` is plain lower-case words (no apostrophes, no repeated letters); `(a|b)` is one of, `[a|b]` optional,
`...` up to three filler words. The matcher normalises text first, so "dieee", "d i e", "k1ll" and "I'm" are already
covered. Give a real example; `patterns.test.ts` checks that it matches, and a template with a typo, a nested group or
an apostrophe throws when the module loads. Self-harm and abuse hits always get the fixed safe reply. `guardData.ts`
is the small jailbreak list used only when the classifier is down; `safety/rejectionRules.ts` holds what makes a model
reply be rejected. Keep sexual and graphic phrasing out of the repository.

## Decisions where the documents left room

- A pattern-forced crisis reply calls **no model at all, not even the classifier**: the case must not depend on a
  network call (ADR 0008: "the crisis path has no model in it"). The reviewer gets the redacted excerpt and the
  pattern categories, without the classifier's summary.
- The classifier and the tutor start together, so the steer note and the privacy reminder (instructions the first
  call did not have) cost a second tutor call on turns where the verdict asks for them.
- With a null verdict the output check runs even if `tutor.output_check` is off; a check that cannot run replaces
  the reply (fail closed).
- `guardian_visible_categories` is honoured literally, and only for turns that open a case.
- The tutor call gets `max_reply_tokens + 512` as `max_tokens`, because adaptive thinking spends output tokens first.
