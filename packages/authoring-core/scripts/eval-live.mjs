#!/usr/bin/env node
// Opt-in LIVE evaluation of the content engine against the real model.
//
//   ANTHROPIC_API_KEY=... node packages/authoring-core/scripts/eval-live.mjs --out eval-report.md
//
// What it does, with the same createJobEngine + createAnthropicLlm the edge function uses:
//   1. scheme_ingest  : reads docs/reference/P1_Basic_Science_Scheme_of_Work.pdf natively (P1 Basic Science,
//                       term 1) and compares the extracted weeks with the p1BasicScienceTerm1 fixture
//                       (exact topic and subtopic match rate).
//   2. chapter_plan   : plans chapters from the extracted scheme (or the fixture when the extraction is unusable).
//   3. unit_generate  : drafts week 2 and compares it with the golden Unit 2 by lint report and a checklist
//                       (section types, enrichment count, mastery check, tutor scripts, reading level).
//   4. prints usage totals and writes a markdown report to --out (and the unit JSON next to it).
//
// It costs real money (about a dozen to twenty Claude calls for the unit alone). It does nothing without a key:
//   ANTHROPIC_API_KEY not set: nothing to evaluate
//
// Options
//   --out <file>      markdown report path (default ./eval-live-report.md)
//   --pdf <file>      scheme PDF (default docs/reference/P1_Basic_Science_Scheme_of_Work.pdf)
//   --term <1|2|3>    term to evaluate (default 1; the fixtures cover all three)
//   --week <n>        scheme week to draft as a unit (default 2, the golden unit)
//   --skip-unit       stop after the chapter plan
//   --demo            NO NETWORK, NO KEY: run the whole flow with the fixture-backed demo model. This exercises
//                     everything except the model (bundling, PDF loading, comparison, report) and labels the
//                     report "DEMO", so it can never pass for a live result.
//
// The key is read from the environment only. It is never printed or written, and neither are request bodies.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { build } from 'esbuild';

const root = new URL('../../..', import.meta.url).pathname;

// ---------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index !== -1 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')
    ? process.argv[index + 1]
    : fallback;
}
const flag = (name) => process.argv.includes(name);

const demo = flag('--demo');
const outPath = resolve(argValue('--out', 'eval-live-report.md'));
const pdfPath = resolve(
  root,
  argValue('--pdf', 'docs/reference/P1_Basic_Science_Scheme_of_Work.pdf'),
);
const term = Number(argValue('--term', '1'));
const weekNo = Number(argValue('--week', '2'));
const skipUnit = flag('--skip-unit');

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!demo && (apiKey === undefined || apiKey.trim() === '')) {
  console.log('ANTHROPIC_API_KEY not set: nothing to evaluate');
  process.exit(0);
}
if (![1, 2, 3].includes(term) || !Number.isInteger(weekNo) || weekNo < 1) {
  console.error('--term must be 1, 2 or 3 and --week a positive whole number');
  process.exit(1);
}
if (!existsSync(pdfPath)) {
  console.error(`The scheme PDF was not found: ${pdfPath}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------------------------
// Bundle the package in memory (as scripts/generate-seed.mjs does) and import it from a data URL
// ---------------------------------------------------------------------------------------------

const bundle = await build({
  stdin: {
    contents: [
      "export * from './packages/authoring-core/src/index.ts';",
      "export { createDemoLlm, DEMO_MODEL_ID } from './packages/authoring-core/src/fakes/index.ts';",
      "export * from './packages/content-schema/src/index.ts';",
      "export { p1BasicScienceSchemes, goldenUnit2 } from './packages/content-schema/src/fixtures/index.ts';",
    ].join('\n'),
    resolveDir: root,
    sourcefile: 'eval-entry.ts',
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
  createJobEngine,
  createAnthropicLlm,
  createDemoLlm,
  DEFAULT_AI_SETTINGS,
  DEFAULT_CAST,
  PROMPT_VERSION,
  StepError,
  parseUnit,
  lintUnit,
  groupIntoChapters,
  averageSentenceLength,
  sectionsOf,
  questionsOf,
  isEnrichmentType,
  p1BasicScienceSchemes,
  goldenUnit2,
} = lib;

const fixtureScheme = p1BasicScienceSchemes[term - 1];

// ---------------------------------------------------------------------------------------------
// The model and the driver
// ---------------------------------------------------------------------------------------------

const settings = DEFAULT_AI_SETTINGS;
let llm;
let modelLabel;
if (demo) {
  llm = createDemoLlm();
  modelLabel = 'DEMO (fixture-backed demo model, no network)';
} else {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  llm = createAnthropicLlm({ client: new Anthropic({ apiKey }), models: settings.models });
  modelLabel = `authoring ${settings.models.authoring}`;
}

const engine = createJobEngine();
const deps = {
  llm,
  settings,
  loadUpload: (path) =>
    Promise.resolve({ bytes: new Uint8Array(readFileSync(path)), mime: 'application/pdf' }),
  now: () => new Date(),
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Runs a job to the end the way the client does: one step at a time, retrying retryable failures. */
async function runKind(kind, rawInput) {
  const input = engine.parseInput(kind, rawInput);
  let state = { outputs: {} };
  const steps = [];
  const usage = [];
  let result;
  const started = Date.now();
  for (;;) {
    const step = engine.nextStep(kind, input, state);
    if (step === null) break;
    let outcome;
    for (let attempt = 1; ; attempt += 1) {
      try {
        outcome = await engine.runStep({ kind, input, state, step }, deps);
        break;
      } catch (error) {
        if (error instanceof StepError) usage.push(...error.usage);
        const retry = error instanceof StepError && error.retryable && attempt < 3;
        console.log(
          `  ${kind}:${step} failed (${error.code ?? 'error'}): ${error.message.split('\n')[0]}${retry ? ' - retrying' : ''}`,
        );
        if (!retry)
          return {
            kind,
            input,
            steps,
            usage,
            result,
            state,
            error,
            seconds: (Date.now() - started) / 1000,
          };
        await sleep(error.retryAfterMs ?? 2000 * attempt);
      }
    }
    usage.push(...outcome.usage);
    steps.push(step);
    if (outcome.result !== undefined) result = outcome.result;
    state = { outputs: { ...state.outputs, [step]: outcome.output } };
    const progress = engine.progress(kind, input, state);
    console.log(`  ${kind}: ${step} done (${progress.done.length}/${progress.total})`);
  }
  return {
    kind,
    input,
    steps,
    usage,
    result,
    state,
    error: null,
    seconds: (Date.now() - started) / 1000,
  };
}

// ---------------------------------------------------------------------------------------------
// Comparisons
// ---------------------------------------------------------------------------------------------

function compareSchemes(extracted, fixture) {
  const byNo = new Map(extracted.weeks.map((week) => [week.week_no, week]));
  const problems = [];
  let topicOk = 0;
  let kindOk = 0;
  let subOk = 0;
  let subTotal = 0;
  for (const wanted of fixture.weeks) {
    subTotal += wanted.subtopics.length;
    const got = byNo.get(wanted.week_no);
    if (!got) {
      problems.push(`week ${wanted.week_no}: missing from the extraction`);
      continue;
    }
    if (got.topic === wanted.topic) topicOk += 1;
    else
      problems.push(`week ${wanted.week_no} topic: expected "${wanted.topic}", got "${got.topic}"`);
    if (got.kind === wanted.kind) kindOk += 1;
    else problems.push(`week ${wanted.week_no} kind: expected ${wanted.kind}, got ${got.kind}`);
    const have = new Set(got.subtopics);
    for (const line of wanted.subtopics) {
      if (have.has(line)) subOk += 1;
      else problems.push(`week ${wanted.week_no} subtopic missing or different: "${line}"`);
    }
    const wantedSet = new Set(wanted.subtopics);
    for (const line of got.subtopics) {
      if (!wantedSet.has(line))
        problems.push(`week ${wanted.week_no} extra or altered subtopic: "${line}"`);
    }
  }
  const total = fixture.weeks.length;
  return {
    weeks: `${extracted.weeks.length} extracted, ${total} expected`,
    topicRate: topicOk / total,
    kindRate: kindOk / total,
    subtopicRate: subTotal === 0 ? 1 : subOk / subTotal,
    topicOk,
    kindOk,
    subOk,
    subTotal,
    total,
    problems,
  };
}

const pct = (value) => `${(value * 100).toFixed(1)}%`;

function questionKinds(unit) {
  const counts = {};
  for (const question of Object.values(questionsOf(unit)))
    counts[question.kind] = (counts[question.kind] ?? 0) + 1;
  return counts;
}

function readingTable(unit) {
  if (unit.header.stage === 'express') return [];
  return sectionsOf(unit).map((section) => {
    const average = averageSentenceLength(section.blocks);
    return { id: section.id, type: section.type, average };
  });
}

function checklist(unit) {
  const sections = sectionsOf(unit);
  const types = new Set(sections.map((s) => s.type));
  const goldenTypes = new Set(sectionsOf(goldenUnit2).map((s) => s.type));
  const enrichment = sections.filter((s) => isEnrichmentType(s.type));
  const goldenEnrichment = sectionsOf(goldenUnit2).filter((s) => isEnrichmentType(s.type));
  const mastery = sections.filter((s) => s.type === 'mastery_check');
  const withTutor = sections.filter((s) => (s.tutor_script?.nodes.length ?? 0) > 0);
  const goldenWithTutor = sectionsOf(goldenUnit2).filter(
    (s) => (s.tutor_script?.nodes.length ?? 0) > 0,
  );
  const illustrations = sections.flatMap((s) => s.blocks.filter((b) => b.type === 'illustration'));
  const readings = readingTable(unit).filter((row) => row.average !== null);
  const over = readings.filter((row) => row.average > 12);
  const lastType = sections[sections.length - 1]?.type;
  const required = [
    'concept',
    'worked_examples',
    'practice',
    'think_deeper',
    'quick_fire',
    'mastery_check',
  ];
  const rows = [
    [
      'Always-present section types',
      required.every((t) => types.has(t)),
      `missing: ${required.filter((t) => !types.has(t)).join(', ') || 'none'}`,
    ],
    [
      'Enrichment sections, 2 to 5, each once',
      enrichment.length >= 2 &&
        enrichment.length <= 5 &&
        new Set(enrichment.map((s) => s.type)).size === enrichment.length,
      `${enrichment.length} (${enrichment.map((s) => s.type).join(', ')}); golden has ${goldenEnrichment.length}`,
    ],
    [
      'Section types golden has, here too',
      [...goldenTypes].every((t) => types.has(t)),
      `golden-only types missing here: ${[...goldenTypes].filter((t) => !types.has(t)).join(', ') || 'none'}`,
    ],
    [
      'Mastery check present and last',
      mastery.length >= 1 && lastType === 'mastery_check',
      `last section is ${lastType}`,
    ],
    [
      'Tutor scripts present',
      withTutor.length >= 3,
      `${withTutor.length} of ${sections.length} sections have one; golden ${goldenWithTutor.length} of ${sectionsOf(goldenUnit2).length}`,
    ],
    [
      'Every picture has alt text and a brief',
      illustrations.every((b) => b.alt.trim() !== '' && b.brief.trim() !== ''),
      `${illustrations.length} picture(s)`,
    ],
    [
      'Reading level, average words per sentence at or under 12 in every section',
      over.length === 0,
      over.length === 0
        ? 'all sections within the limit'
        : over.map((r) => `${r.id} ${r.average.toFixed(1)}`).join(', '),
    ],
  ];
  if (unit.kind === 'lesson') {
    rows.push([
      'Workbook: three tiers, a drill and an application task',
      unit.workbook.tiers.length === 3 &&
        unit.workbook.quick_answer_drill.question_ids.length > 0 &&
        Boolean(unit.workbook.application_task_id),
      `${unit.workbook.tiers.map((t) => t.question_ids.length).join('/')} per tier, ${unit.workbook.quick_answer_drill.question_ids.length} drill questions`,
    ]);
    rows.push([
      "Teacher's manual: script per section and a helper script",
      unit.teacher_manual.script.length >= sections.length &&
        unit.teacher_manual.helper_script.length >= 1,
      `${unit.teacher_manual.script.length} script entries for ${sections.length} sections, ${unit.teacher_manual.helper_script.length} helper entries`,
    ]);
  }
  return rows;
}

function usageTotals(usage) {
  const total = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ms: 0 };
  const byLabel = new Map();
  for (const record of usage) {
    for (const bucket of [
      total,
      byLabel.get(record.label) ??
        byLabel
          .set(record.label, { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ms: 0 })
          .get(record.label),
    ]) {
      bucket.calls += 1;
      bucket.input += record.input_tokens;
      bucket.output += record.output_tokens;
      bucket.cacheRead += record.cache_read_tokens;
      bucket.cacheWrite += record.cache_creation_tokens;
      bucket.ms += record.duration_ms;
    }
  }
  return { total, byLabel };
}

// ---------------------------------------------------------------------------------------------
// The evaluation
// ---------------------------------------------------------------------------------------------

const report = [];
const allUsage = [];
const say = (line = '') => report.push(line);
const now = new Date().toISOString();

say(
  demo
    ? '# Content engine evaluation: DEMO RUN (not a live result)'
    : '# Content engine live evaluation',
);
say();
if (demo) {
  say(
    '> **DEMO.** This run used the fixture-backed demo model. Nothing here says anything about Claude. It only shows that the script, the bundle, the PDF loading, the comparisons and the report work.',
  );
  say();
}
say(`- Run at: ${now}`);
say(`- Model: ${modelLabel}`);
say(`- Prompt version: ${PROMPT_VERSION}`);
say(`- Scheme: P1 Basic Science, term ${term}, from \`${basename(pdfPath)}\``);
say();

console.log(`${demo ? 'DEMO run' : 'Live run'}: ${modelLabel}`);

// --- 1. scheme_ingest ---
console.log('1. scheme_ingest');
const ingest = await runKind('scheme_ingest', {
  subject_slug: 'basic-science',
  subject_name: 'Basic Science',
  level_code: 'P1',
  term,
  source: { type: 'pdf', path: pdfPath, filename: basename(pdfPath) },
});
allUsage.push(...ingest.usage);
say('## 1. scheme_ingest');
say();
let scheme = fixtureScheme;
let schemeSource = 'the p1BasicScienceTerm1 fixture (the extraction was not usable)';
if (ingest.error) {
  say(`**Failed:** ${ingest.error.code ?? 'error'}: ${ingest.error.message}`);
} else {
  const cmp = compareSchemes(ingest.result.scheme, fixtureScheme);
  say(`- Weeks: ${cmp.weeks}`);
  say(`- Topics matching exactly: **${cmp.topicOk}/${cmp.total} (${pct(cmp.topicRate)})**`);
  say(`- Subtopics matching exactly: **${cmp.subOk}/${cmp.subTotal} (${pct(cmp.subtopicRate)})**`);
  say(`- Week kinds matching: ${cmp.kindOk}/${cmp.total} (${pct(cmp.kindRate)})`);
  say(`- Engine flags: ${ingest.result.flags.length}`);
  for (const f of ingest.result.flags)
    say(`  - [${f.severity}] ${f.code}${f.week_no ? ` (week ${f.week_no})` : ''}: ${f.message}`);
  if (cmp.problems.length > 0) {
    say();
    say('Differences from the fixture (first 25):');
    for (const problem of cmp.problems.slice(0, 25)) say(`  - ${problem}`);
    if (cmp.problems.length > 25) say(`  - ... and ${cmp.problems.length - 25} more`);
  }
  const teaching = ingest.result.scheme.weeks.filter((w) => w.kind === 'teaching').length;
  if (
    teaching > 0 &&
    !ingest.result.flags.some((f) => f.severity === 'concern' && f.code === 'duplicate_week')
  ) {
    scheme = ingest.result.scheme;
    schemeSource = 'the extraction above';
  }
}
say();

// --- 2. chapter_plan ---
console.log('2. chapter_plan');
const plan = await runKind('chapter_plan', {
  scheme_id: globalThis.crypto.randomUUID(),
  scheme,
  subject_name: 'Basic Science',
  cast: DEFAULT_CAST,
});
allUsage.push(...plan.usage);
say('## 2. chapter_plan');
say();
say(`Planned from ${schemeSource}.`);
say();
if (plan.error) {
  say(`**Failed:** ${plan.error.code ?? 'error'}: ${plan.error.message}`);
} else {
  const grouping = groupIntoChapters(scheme);
  const same =
    JSON.stringify(plan.result.plan.chapters.map((c) => c.units.map((u) => u.week_no))) ===
    JSON.stringify(grouping.chapters.map((c) => c.week_nos));
  say(`- Structure equals the deterministic grouping: **${same ? 'yes' : 'NO'}**`);
  say(
    `- Flags: ${plan.result.flags.length === 0 ? 'none' : plan.result.flags.map((f) => `${f.code}: ${f.message}`).join(' | ')}`,
  );
  say();
  say('| Chapter | Unit | Week | Title | Stage | Periods | Objective |');
  say('| --- | --- | --- | --- | --- | --- | --- |');
  for (const chapter of plan.result.plan.chapters) {
    for (const unit of chapter.units) {
      say(
        `| ${chapter.chapter_no}. ${chapter.title}${chapter.theme ? ` (theme: ${chapter.theme.title})` : ''} | ${unit.unit_no} | ${unit.week_no} | ${unit.title} | ${unit.stage}${unit.stage_to ? ` to ${unit.stage_to}` : ''} | ${unit.periods} | ${unit.objective.replace(/\|/g, '/')} |`,
      );
    }
  }
}
say();

// --- 3. unit_generate ---
let generated = null;
let unit = null;
if (!skipUnit && !plan.error) {
  console.log(`3. unit_generate (week ${weekNo})`);
  const chapter = plan.result.plan.chapters.find((c) => c.units.some((u) => u.week_no === weekNo));
  const planned = chapter?.units.find((u) => u.week_no === weekNo);
  const week = scheme.weeks.find((w) => w.week_no === weekNo);
  if (!chapter || !planned || !week) {
    say('## 3. unit_generate');
    say();
    say(`Week ${weekNo} is not a planned teaching week of this scheme, so no unit was drafted.`);
  } else {
    const earlier = chapter.units.filter((u) => u.unit_no < planned.unit_no).slice(-3);
    generated = await runKind('unit_generate', {
      unit: {
        id: globalThis.crypto.randomUUID(),
        kind: planned.kind,
        unit_no: planned.unit_no,
        week_no: planned.week_no,
        title: planned.title,
        objective: planned.objective,
        stage: planned.stage,
        ...(planned.stage_to ? { stage_to: planned.stage_to } : {}),
        periods: planned.periods,
      },
      chapter: { number: chapter.chapter_no, title: chapter.title },
      subject: { slug: 'basic-science', name: 'Basic Science' },
      level_code: 'P1',
      term,
      ...(chapter.theme ? { theme: chapter.theme } : {}),
      scheme_week: { topic: week.topic, subtopics: week.subtopics },
      prior_units: earlier.map((u) => ({
        unit_no: u.unit_no,
        title: u.title,
        objective: u.objective,
        key_terms: [],
      })),
      previous_enrichment: [],
      cast: DEFAULT_CAST,
    });
    allUsage.push(...generated.usage);
    say('## 3. unit_generate');
    say();
    if (generated.error) {
      say(
        `**Failed at ${generated.error.step ?? 'a step'}:** ${generated.error.code ?? 'error'}: ${generated.error.message}`,
      );
      say(`Steps completed: ${generated.steps.join(', ')}`);
    } else {
      const result = generated.result;
      unit = parseUnit(result.content);
      say(`- Steps: ${generated.steps.length} (${generated.steps.join(' > ')})`);
      say(`- Took ${generated.seconds.toFixed(0)} s`);
      say(
        `- Lint: **${result.lint.errors.length} error(s)**, ${result.lint.warnings.length} warning(s); ok = ${result.lint.ok}`,
      );
      for (const e of result.lint.errors)
        say(`  - ERROR ${e.code}${e.path ? ` at ${e.path}` : ''}: ${e.message}`);
      for (const w of result.lint.warnings)
        say(`  - warning ${w.code}${w.path ? ` at ${w.path}` : ''}: ${w.message}`);
      say(`- Review flags: ${result.review.length}`);
      for (const f of result.review)
        say(`  - [${f.severity}] ${f.code}${f.path ? ` at ${f.path}` : ''}: ${f.message}`);
      const goldenReport = lintUnit(goldenUnit2, {});
      say(
        `- Golden Unit 2 for comparison: ${goldenReport.errors.length} error(s), warnings: ${goldenReport.warnings.map((w) => w.code).join(', ') || 'none'}`,
      );
      say();
      say('| Check | Pass | Detail |');
      say('| --- | --- | --- |');
      for (const [name, pass, detail] of checklist(unit))
        say(`| ${name} | ${pass ? 'yes' : '**NO**'} | ${detail} |`);
      say();
      const kinds = questionKinds(unit);
      const goldenKinds = questionKinds(goldenUnit2);
      say(`Questions by kind: ${JSON.stringify(kinds)} (golden: ${JSON.stringify(goldenKinds)})`);
      say();
      const readings = readingTable(unit);
      if (readings.length > 0) {
        say('Reading level (average words per sentence; the lint limit is 12):');
        say();
        say('| Section | Type | Average |');
        say('| --- | --- | --- |');
        for (const row of readings)
          say(
            `| ${row.id} | ${row.type} | ${row.average === null ? 'n/a' : row.average.toFixed(1)} |`,
          );
        say();
      }
      say("Outline notes (adjustments the code made to the model's plan):");
      const outline = generated.state.outputs.outline;
      say(
        outline && outline.notes.length > 0
          ? outline.notes.map((n) => `- ${n}`).join('\n')
          : '- none',
      );
      const unitPath = `${outPath.replace(/\.md$/, '')}.unit.json`;
      mkdirSync(dirname(unitPath), { recursive: true });
      writeFileSync(unitPath, JSON.stringify(result.content, null, 2));
      say();
      say(
        `The drafted unit was written to \`${unitPath}\`. Open it in the admin preview and read it as a teacher would: the checklist cannot judge quality.`,
      );
    }
  }
  say();
}

// --- 4. usage ---
say('## 4. Usage');
say();
const { total, byLabel } = usageTotals(allUsage);
say(
  `Total: ${total.calls} call(s), ${total.input} input, ${total.output} output, ${total.cacheRead} cache-read and ${total.cacheWrite} cache-write tokens, ${(total.ms / 1000).toFixed(0)} s of model time. Cost is not estimated here (prices are entered by the owner in the admin Usage screen).`,
);
say();
say('| Step | Calls | Input | Output | Cache read | Cache write | Seconds |');
say('| --- | --- | --- | --- | --- | --- | --- |');
for (const [label, bucket] of byLabel) {
  say(
    `| ${label} | ${bucket.calls} | ${bucket.input} | ${bucket.output} | ${bucket.cacheRead} | ${bucket.cacheWrite} | ${(bucket.ms / 1000).toFixed(1)} |`,
  );
}
say();
say('## What to read by hand');
say();
say(
  '- The unit JSON (or the admin preview): voice, facts, every question and answer, tutor lines, alt text, the helper script.',
);
say(
  '- The cast: nothing about Zari and Zuri beyond "female, 7" and "male, almost 5" and the age-derived guidance.',
);
say(
  '- Religion-neutral values and Nigerian anchors; the global window; whether every scheme subtopic is taught.',
);

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${report.join('\n')}\n`);

console.log('');
console.log(
  `Usage: ${total.calls} call(s), ${total.input} in / ${total.output} out tokens (${total.cacheRead} cache read, ${total.cacheWrite} cache write)`,
);
if (generated?.result)
  console.log(
    `Unit lint: ${generated.result.lint.errors.length} error(s), ${generated.result.lint.warnings.length} warning(s)`,
  );
console.log(`Report written to ${outPath}`);
const failed = [ingest, plan, generated].some((run) => run?.error);
process.exit(failed && !demo ? 2 : 0);
