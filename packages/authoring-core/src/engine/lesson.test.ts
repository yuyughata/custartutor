import { describe, expect, it } from 'vitest';
import {
  lintUnit,
  parseUnit,
  questionsOf,
  sectionsOf,
  isEnrichmentType,
} from '@custar/content-schema';
import { DEFAULT_AI_SETTINGS, StepError, type JobKind, type JobState } from '../contract';
import { DEMO_MODEL_ID, createDemoLlm } from '../fakes/demoLlm';
import { createJobEngine } from './engine';
import { PROMPT_VERSION } from './index';
import {
  goldenUnit2,
  makeDeps,
  runJobToEnd,
  sampleChapterPlanInput,
  sampleReviseInput,
  sampleSchemeInput,
  sampleUnitInput,
  type JobRun,
} from '../../test-support/testKit';

const engine = createJobEngine();
const ALLOWED_WARNINGS = new Set(['no_global_window', 'reading_level']);

async function generate(overrides = {}, serialise = true) {
  const input = engine.parseInput('unit_generate', sampleUnitInput(overrides));
  const run = await runJobToEnd(engine, 'unit_generate', input, makeDeps(createDemoLlm()), {
    serialise,
  });
  return { input, run };
}

describe('unit_generate (lesson) through the demo model', () => {
  it('produces a unit that parses strictly and lints with no errors', async () => {
    const { input, run } = await generate();
    const result = run.result!;
    const unit = parseUnit(result.content);
    const report = lintUnit(unit, { previousEnrichment: input.previous_enrichment });
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
    for (const warning of report.warnings)
      expect(ALLOWED_WARNINGS.has(warning.code), warning.code).toBe(true);
    expect(result.lint.ok).toBe(true);
    expect(result.lint.errors).toEqual([]);
    expect(unit.kind).toBe('lesson');
    // the NERDC objective is carried verbatim, not rewritten
    expect(unit.header.objective).toBe(input.unit.objective);
    expect(result.summary).toMatch(/Drafted/);
    expect(result.review.some((flag) => flag.message.includes('DEMO MODEL'))).toBe(true);
  });

  it('runs the planned steps in order, one step per section', async () => {
    const { run } = await generate();
    expect(run.steps[0]).toBe('outline');
    expect(run.steps.slice(-4)).toEqual(['workbook', 'manual', 'assemble', 'review']);
    const sections = run.steps.filter((step) => step.startsWith('section:'));
    expect(sections.length).toBeGreaterThanOrEqual(8);
    expect(sections[sections.length - 1]).toBe('section:mastery_check');
    expect(run.steps).not.toContain('repair:1');
  });

  it('reports usage from the model that served the call, one record per call', async () => {
    const { run } = await generate();
    expect(run.usage.length).toBe(run.steps.filter((s) => !['assemble'].includes(s)).length);
    for (const record of run.usage) {
      expect(record.model).toBe(DEMO_MODEL_ID);
      expect(record.task).toBe('authoring');
      expect(record.label.startsWith('unit_generate:')).toBe(true);
      expect(record.duration_ms).toBeGreaterThanOrEqual(0);
    }
  });

  it('progress reflects the dynamic plan: the total grows after the outline', async () => {
    const input = engine.parseInput('unit_generate', sampleUnitInput());
    const deps = makeDeps(createDemoLlm());
    const before = engine.progress('unit_generate', input, { outputs: {} });
    expect(before.next).toBe('outline');
    expect(before.done).toEqual([]);
    const outline = await engine.runStep(
      { kind: 'unit_generate', input, state: { outputs: {} }, step: 'outline' },
      deps,
    );
    const state: JobState = { outputs: { outline: outline.output } };
    const after = engine.progress('unit_generate', input, state);
    expect(after.done).toEqual(['outline']);
    expect(after.total).toBeGreaterThan(before.total + 8);
    expect(after.next).toBe('section:story_opener');
    expect(engine.nextStep('unit_generate', input, state)).toBe('section:story_opener');
  });

  it('uses 2 to 5 enrichment sections, each type once', async () => {
    const { run } = await generate();
    const unit = parseUnit(run.result!.content);
    const enrichment = sectionsOf(unit)
      .filter((s) => isEnrichmentType(s.type))
      .map((s) => s.type);
    expect(enrichment.length).toBeGreaterThanOrEqual(2);
    expect(enrichment.length).toBeLessThanOrEqual(5);
    expect(new Set(enrichment).size).toBe(enrichment.length);
    // the default for a Primary 1 lesson with an earlier unit is the template's five
    expect([...enrichment].sort()).toEqual([
      'character_values',
      'do_and_discover',
      'remember',
      'story_opener',
      'tell_it_back',
    ]);
    const last = sectionsOf(unit)[sectionsOf(unit).length - 1]!;
    expect(last.type).toBe('mastery_check');
  });

  it("rotates away from the previous unit's enrichment set", async () => {
    const template = [
      'story_opener',
      'remember',
      'do_and_discover',
      'character_values',
      'tell_it_back',
    ] as const;
    const { run } = await generate({ previous_enrichment: [...template] });
    const unit = parseUnit(run.result!.content);
    const enrichment = sectionsOf(unit)
      .filter((s) => isEnrichmentType(s.type))
      .map((s) => s.type);
    expect([...enrichment].sort()).not.toEqual([...template].sort());
    expect(enrichment.length).toBeGreaterThanOrEqual(2);
    expect(run.result!.lint.warnings.map((w) => w.code)).not.toContain('enrichment_not_rotated');
  });

  it('leaves Remember? out when the subject has no earlier unit', async () => {
    const { run } = await generate({ prior_units: [] });
    const unit = parseUnit(run.result!.content);
    expect(sectionsOf(unit).map((s) => s.type)).not.toContain('remember');
    expect(run.result!.lint.ok).toBe(true);
  });

  it('assigns the same ids in two runs (ids come from code, never from the model)', async () => {
    const a = await generate();
    const b = await generate();
    expect(a.run.result!.content).toEqual(b.run.result!.content);
    const unit = parseUnit(a.run.result!.content);
    expect(sectionsOf(unit).map((s) => s.id)).toEqual(
      expect.arrayContaining(['story_opener', 'concept_1', 'practice', 'mastery_check']),
    );
    for (const id of Object.keys(questionsOf(unit))) expect(id).toMatch(/^q_[a-z0-9_]+$/);
  });

  it('drafts a lesson that has no scheme week, with a note about the week number', async () => {
    const base = sampleUnitInput();
    const { run } = await generate({ scheme_week: null, unit: { ...base.unit, week_no: null } });
    const unit = parseUnit(run.result!.content);
    expect(unit.header.week_no).toBe(2);
    expect(run.result!.lint.ok).toBe(true);
    expect(run.result!.review.some((flag) => /no scheme week/.test(flag.message))).toBe(true);
  });

  it('builds the workbook tiers from the practice section and the answers note from the questions', async () => {
    const { run } = await generate();
    const unit = parseUnit(run.result!.content);
    if (unit.kind !== 'lesson') throw new Error('lesson expected');
    const tiers = unit.workbook.tiers;
    expect(tiers.map((t) => t.tier)).toEqual([1, 2, 3]);
    const practice = sectionsOf(unit).find((s) => s.type === 'practice')!;
    const placed = practice.blocks.flatMap((b) => (b.type === 'question' ? [b.question_id] : []));
    expect(tiers.flatMap((t) => t.question_ids).sort()).toEqual([...placed].sort());
    expect(unit.workbook.answers_note).toMatch(/Quick-Answer/);
    expect(unit.teacher_manual.timing).toMatch(/Two periods/);
    expect(unit.session_plan.length).toBe(2);
    expect(unit.session_plan.flatMap((p) => p.sections).sort()).toEqual(
      sectionsOf(unit)
        .map((s) => s.id)
        .sort(),
    );
  });

  it('is resumable: the same result whether or not the state is serialised between steps', async () => {
    const serialised = await generate({}, true);
    const direct = await generate({}, false);
    expect(direct.run.result).toEqual(serialised.run.result);
    expect(direct.run.steps).toEqual(serialised.run.steps);
  });

  it('every step is idempotent for the same (input, state, step)', async () => {
    const input = engine.parseInput('unit_generate', sampleUnitInput());
    const deps = makeDeps(createDemoLlm());
    let state: JobState = { outputs: {} };
    for (;;) {
      const step = engine.nextStep('unit_generate', input, state);
      if (step === null) break;
      const first = await engine.runStep({ kind: 'unit_generate', input, state, step }, deps);
      const second = await engine.runStep({ kind: 'unit_generate', input, state, step }, deps);
      expect(second.output, step).toEqual(first.output);
      expect(second.result, step).toEqual(first.result);
      state = JSON.parse(
        JSON.stringify({ outputs: { ...state.outputs, [step]: first.output } }),
      ) as JobState;
    }
  });

  it('re-running an early step with later outputs in the state gives the same output', async () => {
    const { run, input } = await generate();
    const deps = makeDeps(createDemoLlm());
    for (const step of ['outline', 'section:concept_1', 'workbook', 'manual', 'assemble']) {
      const rerun = await engine.runStep(
        { kind: 'unit_generate', input, state: run.state, step },
        deps,
      );
      expect(rerun.output, step).toEqual(run.state.outputs[step]);
    }
  });

  it('carries the PROMPT_VERSION that the settings default to', () => {
    expect(PROMPT_VERSION).toBe(DEFAULT_AI_SETTINGS.prompt_version);
  });
});

describe('other unit kinds through the demo model', () => {
  for (const kind of ['mini_project', 'term_project', 'revision', 'assessment'] as const) {
    it(`${kind} parses strictly, lints with no errors and is idempotent`, async () => {
      const base = sampleUnitInput();
      const input = engine.parseInput('unit_generate', {
        ...base,
        unit: { ...base.unit, kind, stage_to: base.unit.stage_to },
        theme: undefined,
        scheme_week: kind === 'revision' || kind === 'assessment' ? null : base.scheme_week,
      });
      const deps = makeDeps(createDemoLlm());
      const run = await runJobToEnd(engine, 'unit_generate', input, deps);
      const unit = parseUnit(run.result!.content);
      expect(unit.kind).toBe(kind);
      expect(lintUnit(unit).errors).toEqual([]);
      expect(run.steps).toEqual(['draft', 'assemble', 'review']);
      const again = await engine.runStep(
        { kind: 'unit_generate', input, state: run.state, step: 'draft' },
        deps,
      );
      expect(again.output).toEqual(run.state.outputs['draft']);
    });
  }
});

describe('parseInput', () => {
  const kinds: [JobKind, unknown][] = [
    ['scheme_ingest', { nonsense: true }],
    ['chapter_plan', {}],
    ['unit_generate', { unit: {} }],
    ['unit_revise', { instruction: 'x' }],
  ];
  for (const [kind, bad] of kinds) {
    it(`rejects invalid ${kind} input with StepError(input, invalid_input)`, () => {
      try {
        engine.parseInput(kind, bad);
        throw new Error('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(StepError);
        expect((error as StepError).step).toBe('input');
        expect((error as StepError).code).toBe('invalid_input');
        expect((error as StepError).retryable).toBe(false);
      }
    });
  }

  it('accepts valid inputs for every kind and normalises the cast traits', () => {
    expect(engine.parseInput('scheme_ingest', sampleSchemeInput()).term).toBe(1);
    expect(
      engine.parseInput('chapter_plan', sampleChapterPlanInput()).cast[0]!.traits.personality,
    ).toEqual([]);
    const lesson = engine.parseInput('unit_generate', sampleUnitInput());
    expect(lesson.cast.map((c) => c.name)).toEqual(['Zari', 'Zuri']);
    expect(
      engine.parseInput('unit_revise', sampleReviseInput(goldenUnit2)).instruction,
    ).toBeTruthy();
  });

  it('rejects a cast member without a name', () => {
    expect(() =>
      engine.parseInput('unit_generate', { ...sampleUnitInput(), cast: [{ slug: 'x' }] }),
    ).toThrow(StepError);
  });
});

export type { JobRun };
