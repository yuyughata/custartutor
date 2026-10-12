#!/usr/bin/env node
// Opt-in LIVE evaluation of the tutor against the real models.
//
//   ANTHROPIC_API_KEY=... node packages/tutor-core/scripts/eval-tutor-live.mjs --out tutor-eval-report.md
//
// What it does, with the same pipeline and adapters the `tutor-chat` edge function uses (runTutorTurn,
// createAnthropicLlm for the classifier and output check, createAnthropicTutorLlm for the tutor), against the golden
// unit: it runs every case of the adversarial suite (src/evals/adversarial) and checks
//   - the SAFETY ACTION the live classifier + patterns produced against the case's expectation (this is the
//     measurement the offline suite cannot make: how the live classifier rates real attacks);
//   - the fixed reply for crisis inputs;
//   - the deterministic `must_not` properties of the reply (no link, phone, email, mastery answer, personal-data
//     request, human claim, revealed instructions, meeting or secret);
//   - that redaction removed what it should before any model saw the message.
// It writes a markdown report (pass/fail table, failures, token usage). It does NOT judge tone or suitability: the
// property "unsafe_content" cannot be checked by a program, so people who are not the builders must read replies.
//
// It costs real money (a few Claude calls per case) and does nothing without a key:
//   ANTHROPIC_API_KEY not set: nothing to evaluate
//
// Options
//   --out <file>      markdown report path (default ./tutor-eval-report.md)
//   --only <category> run one category of cases
//   --limit <n>       run the first n cases only
//   --demo            NO NETWORK, NO KEY: run the whole flow with the scripted stand-ins (a pattern-list
//                     "classifier" and scripted tutor lines). It exercises the harness, the bundle, the checks and
//                     the report, and labels the report "DEMO RUN (not a live result)".
//
// The key is read from the environment only. It is never printed or written, and neither are request bodies.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { build } from 'esbuild';

const root = new URL('../../..', import.meta.url).pathname;

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index !== -1 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')
    ? process.argv[index + 1]
    : fallback;
}
const flag = (name) => process.argv.includes(name);

const demo = flag('--demo');
const outPath = resolve(argValue('--out', 'tutor-eval-report.md'));
const only = argValue('--only', null);
const limit = Number(argValue('--limit', '0'));

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!demo && (apiKey === undefined || apiKey.trim() === '')) {
  console.log('ANTHROPIC_API_KEY not set: nothing to evaluate');
  process.exit(0);
}

// Bundle the package in memory and import it from a data URL (as the authoring eval does).
const bundle = await build({
  stdin: {
    contents: [
      "export * from './packages/tutor-core/src/index.ts';",
      "export { createDemoModerationLlm, createDemoTutorLlm, demoReplyText } from './packages/tutor-core/src/fakes/index.ts';",
      "export { ADVERSARIAL_CASES, breaches } from './packages/tutor-core/src/evals/adversarial/index.ts';",
      "export { goldenUnit2 } from './packages/content-schema/src/fixtures/index.ts';",
      "export { DEFAULT_CAST, DEFAULT_MODELS } from './packages/authoring-core/src/index.ts';",
    ].join('\n'),
    resolveDir: root,
    sourcefile: 'tutor-eval-entry.ts',
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  logLevel: 'silent',
});
const lib = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
);
const {
  ADVERSARIAL_CASES,
  breaches,
  buildGrounding,
  buildMasteryGuard,
  createAnthropicLlm,
  createAnthropicTutorLlm,
  createDemoModerationLlm,
  createDemoTutorLlm,
  demoReplyText,
  DEFAULT_CAST,
  DEFAULT_MODELS,
  DEFAULT_SAFE_REPLIES,
  DEFAULT_TUTOR_SETTINGS,
  TUTOR_RULES_TEXT,
  fixedReplyKey,
  runTutorTurn,
  goldenUnit2,
} = lib;

const settings = { ...DEFAULT_TUTOR_SETTINGS, enabled: true };
const grounding = buildGrounding(goldenUnit2, {
  versionNo: 1,
  unitId: '11111111-1111-4111-8111-111111111111',
});
const guard = buildMasteryGuard(goldenUnit2);
const checkOptions = {
  masteryGuard: guard,
  castNames: ['Zari', 'Zuri'],
  protectedText: [TUTOR_RULES_TEXT],
};

let realLlm = null;
let realTutor = null;
let modelLabel = 'DEMO (scripted stand-ins, no network)';
if (!demo) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  realLlm = createAnthropicLlm({ client, models: DEFAULT_MODELS });
  realTutor = createAnthropicTutorLlm({ client, models: DEFAULT_MODELS });
  modelLabel = `tutor ${DEFAULT_MODELS.tutor}, moderation ${DEFAULT_MODELS.moderation}`;
}

let cases = ADVERSARIAL_CASES.filter((c) => only === null || c.category === only);
if (limit > 0) cases = cases.slice(0, limit);
console.log(`${demo ? 'DEMO run' : 'Live run'}: ${cases.length} case(s), ${modelLabel}`);

function depsFor(c) {
  if (!demo) return { llm: realLlm, tutorLlm: realTutor, settings, now: () => new Date() };
  // the demo plays a misbehaving model on the cases that have a bad output, so the checks have something to catch
  const text = c.bad_outputs?.[0]
    ? `${c.bad_outputs[0]} Hello.`
    : demoReplyText({ unit: goldenUnit2, turnIndex: 0, childText: c.input });
  return {
    llm: createDemoModerationLlm(c.input),
    tutorLlm: createDemoTutorLlm(text),
    settings,
    now: () => new Date(),
  };
}

function fixedFor(outcome) {
  const key = fixedReplyKey(outcome.safety);
  return key === null ? null : (settings.safe_replies[key] ?? DEFAULT_SAFE_REPLIES[key]);
}

const rows = [];
const usage = [];
for (const [index, c] of cases.entries()) {
  const input = {
    child: { alias: 'Star', level_code: 'P1', stage: 'connect', reading_mode: 'reader' },
    grounding,
    position: { section_id: 'places_in_school' },
    history: c.history ?? [],
    message: { mode: 'text', text: c.input },
    helper_present: false,
    cast: DEFAULT_CAST,
    known_names: ['Testa Sample'],
    ids: {
      session_id: '22222222-2222-4222-8222-222222222222',
      message_id: '33333333-3333-4333-8333-333333333333',
    },
    mastery_guard: guard,
  };
  const run = runTutorTurn(depsFor(c), input);
  for await (const event of run.events) void event;
  const outcome = await run.outcome;
  usage.push(...outcome.usage);

  const problems = [];
  if (outcome.status === 'failed') problems.push(`the turn failed (${outcome.error_code})`);
  if (c.action !== undefined && outcome.safety.action !== c.action) {
    problems.push(`action ${outcome.safety.action}, expected ${c.action}`);
  }
  if (c.fixed_reply !== undefined && outcome.safety.action === 'safe_reply') {
    const key = fixedReplyKey(outcome.safety);
    const expected = c.fixed_reply;
    if (key !== expected && c.action === 'safe_reply')
      problems.push(`safe reply "${key}", expected "${expected}"`);
  }
  const fixed = fixedFor(outcome);
  if (fixed !== null && outcome.reply_text !== fixed)
    problems.push('the fixed reply was not the reply');
  const found = breaches(outcome.reply_text ?? '', c.must_not, checkOptions);
  if (found.length > 0) problems.push(`reply breaches: ${found.join(', ')}`);
  for (const secret of c.redacts ?? []) {
    if (outcome.child_text_redacted.includes(secret))
      problems.push(`"${secret}" survived redaction`);
  }
  rows.push({ c, outcome, problems });
  console.log(
    `  ${index + 1}/${cases.length} ${c.id}: ${problems.length === 0 ? 'ok' : `FAIL (${problems.join('; ')})`}`,
  );
}

const failed = rows.filter((row) => row.problems.length > 0);
const totals = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const byLabel = new Map();
for (const record of usage) {
  const bucket = byLabel.get(record.label) ?? { calls: 0, input: 0, output: 0 };
  bucket.calls += 1;
  bucket.input += record.input_tokens;
  bucket.output += record.output_tokens;
  byLabel.set(record.label, bucket);
  totals.calls += 1;
  totals.input += record.input_tokens;
  totals.output += record.output_tokens;
  totals.cacheRead += record.cache_read_tokens;
  totals.cacheWrite += record.cache_creation_tokens;
}

const cell = (text) => String(text).replace(/\|/g, '/').replace(/\s+/g, ' ');
const report = [];
const say = (line = '') => report.push(line);
say(demo ? '# Tutor evaluation: DEMO RUN (not a live result)' : '# Tutor live evaluation');
say();
if (demo) {
  say(
    '> **DEMO.** This run used scripted stand-ins: a classifier that only knows the pattern lists, and scripted tutor lines (a deliberately bad line on the cases that have one). Cases that rest on the classifier fail here by design. Nothing here says anything about Claude. It only shows that the harness, the bundle, the checks and the report work.',
  );
  say();
}
say(`- Run at: ${new Date().toISOString()}`);
say(`- Models: ${modelLabel}`);
say(`- Unit: ${goldenUnit2.header.title} (golden fixture)`);
say(
  `- Cases: ${cases.length}${only ? ` (category ${only})` : ''}; passed ${rows.length - failed.length}, failed ${failed.length}`,
);
say();
say('| Case | Category | Expected | Got | Status | Result |');
say('| --- | --- | --- | --- | --- | --- |');
for (const { c, outcome, problems } of rows) {
  say(
    `| ${c.id} | ${c.category} | ${c.action ?? '-'} | ${outcome.safety.action} | ${outcome.status} | ${problems.length === 0 ? 'pass' : `**FAIL** ${cell(problems.join('; '))}`} |`,
  );
}
say();
if (failed.length > 0) {
  say('## Failures');
  say();
  for (const { c, outcome, problems } of failed) {
    say(`- **${c.id}** (${c.category}): ${problems.join('; ')}`);
    say(`  - input: ${cell(c.input).slice(0, 120)}`);
    say(`  - reply shown: ${cell(outcome.reply_text ?? '(none)').slice(0, 200)}`);
  }
  say();
}
say('## Usage');
say();
say(
  `${totals.calls} call(s), ${totals.input} input, ${totals.output} output, ${totals.cacheRead} cache-read and ${totals.cacheWrite} cache-write tokens. Cost is not estimated here (prices are entered by the owner).`,
);
say();
say('| Call | Count | Input | Output |');
say('| --- | --- | --- | --- |');
for (const [label, bucket] of byLabel)
  say(`| ${label} | ${bucket.calls} | ${bucket.input} | ${bucket.output} |`);
say();
say('## What this does not show');
say();
say(
  '- Tone, suitability for a young child and subtle unsafe content: no program checks them. Read the replies.',
);
say(
  '- Attacks nobody wrote down. People who are not the builders must red-team the tutor before launch.',
);
say(
  "- The owner's private case list for sexual and graphic categories, which is deliberately not in the repository.",
);

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${report.join('\n')}\n`);
console.log('');
console.log(`Usage: ${totals.calls} call(s), ${totals.input} in / ${totals.output} out tokens`);
console.log(`Report written to ${outPath} (${rows.length - failed.length}/${rows.length} passed)`);
process.exit(failed.length > 0 && !demo ? 2 : 0);
