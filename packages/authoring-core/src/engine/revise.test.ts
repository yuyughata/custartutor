import { describe, expect, it } from 'vitest';
import {
  lintUnit,
  lintVersionIds,
  parseUnit,
  sectionsOf,
  type LessonUnit,
  type UnitContent,
} from '@custar/content-schema';
import { colourChartProject } from '@custar/content-schema/fixtures';
import type { JobState } from '../contract';
import { createDemoLlm } from '../fakes/demoLlm';
import type { AuthorBlock, AuthorQuestion, PatchOutput } from '../prompts/schemas';
import { createJobEngine } from './engine';
import { applyUnitPatch, diffUnits, restoreDroppedIds } from './patch';
import {
  goldenUnit2,
  makeDeps,
  runJobToEnd,
  sampleReviseInput,
  sampleUnitInput,
  scriptedLlm,
  type ScriptedCall,
} from '../../test-support/testKit';
import { clone, toJson } from './util';

const engine = createJobEngine();

const block = (partial: Partial<AuthorBlock> & Pick<AuthorBlock, 'type'>): AuthorBlock => ({
  text: '',
  label: '',
  brief: '',
  alt: '',
  tone: 'none',
  items: [],
  headers: [],
  rows: [],
  question_ref: '',
  ...partial,
});
const question = (
  partial: Partial<AuthorQuestion> & Pick<AuthorQuestion, 'ref' | 'kind' | 'prompt'>,
): AuthorQuestion => ({
  tier: 1,
  hint: '',
  explanation: '',
  skill_tag: '',
  options: [],
  answers: [],
  blanks: [],
  numeric: false,
  units: [],
  pairs: [],
  checks: [],
  exemplar: '',
  ...partial,
});
const patch = (over: Partial<PatchOutput> = {}): PatchOutput => ({
  summary: 'ok',
  sections: [],
  questions: [],
  workbook: { tier1_title: '', tier2_title: '', tier3_title: '', take_it_home: '', not_yet: '' },
  manual: { script: [], helper_script: [], materials: [], got_it: [], not_yet_guidance: '' },
  ...over,
});

/** The golden unit with two enrichment sections removed, so that sections can be added back. */
function trimmedGolden(): LessonUnit {
  const unit = clone(goldenUnit2);
  const drop = new Set(['remember_senses', 'tell_it_back']);
  unit.sections = unit.sections.filter((s) => !drop.has(s.id));
  unit.session_plan = unit.session_plan.map((p) => ({
    ...p,
    sections: p.sections.filter((id) => !drop.has(id)),
  }));
  unit.teacher_manual.script = unit.teacher_manual.script.filter((e) => !drop.has(e.section_id));
  unit.teacher_manual.helper_script = unit.teacher_manual.helper_script.filter(
    (e) => !drop.has(e.section_id),
  );
  return parseUnit(toJson(unit)) as LessonUnit;
}

const ids = (unit: UnitContent) => ({
  sections: sectionsOf(unit).map((s) => s.id),
  questions: Object.keys('questions' in unit && unit.questions ? unit.questions : {}),
});

async function revise(
  base: unknown,
  handler: (n: number) => PatchOutput | undefined,
  instruction = 'Change it.',
  overrides = {},
) {
  const calls: ScriptedCall[] = [];
  const demo = createDemoLlm();
  const llm = {
    async generate<T>(request: Parameters<typeof demo.generate<T>>[0]) {
      calls.push({ request: request as never });
      const custom = request.schemaName === 'unit_patch' ? handler(calls.length - 1) : undefined;
      if (custom) {
        const value = request.schema.parse(custom);
        return {
          value,
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
          },
          model: 'scripted',
          stopReason: 'end_turn',
        };
      }
      return demo.generate(request);
    },
  };
  const input = engine.parseInput('unit_revise', sampleReviseInput(base, instruction, overrides));
  const run = await runJobToEnd(engine, 'unit_revise', input, makeDeps(llm));
  return { run, calls, input };
}

describe('unit_revise through the demo model', () => {
  it('patches by id, keeps every id, reports exactly what changed and lints the result', async () => {
    const { run, calls } = await revise(goldenUnit2, () => undefined, 'Make the story shorter.');
    expect(run.steps).toEqual(['patch', 'apply', 'review']);
    const result = run.result!;
    const next = parseUnit(result.content);
    const before = ids(goldenUnit2);
    const after = ids(next);
    expect(after.sections).toEqual(before.sections);
    expect(after.questions.sort()).toEqual(before.questions.sort());
    expect(result.changed).toEqual({ section_ids: ['come_and_explore'], question_ids: [] });
    expect(lintVersionIds(goldenUnit2, next).errors).toEqual([]);
    expect(result.lint.errors).toEqual([]);
    expect(result.lint.ok).toBe(true);
    // the other sections are byte for byte the base's
    for (const section of sectionsOf(next)) {
      if (section.id !== 'come_and_explore')
        expect(section).toEqual(sectionsOf(goldenUnit2).find((s) => s.id === section.id));
    }
    expect(result.summary).toMatch(/Changed 1 section/);
    // the model saw the base unit and the instruction, and reviewed only the changed part
    expect(calls.map((c) => c.request.label)).toEqual(['unit_revise:patch', 'unit_revise:review']);
    const reviewText = String(calls[1]!.request.messages[0]!.content);
    expect(reviewText).toContain('come_and_explore');
    expect(reviewText).not.toContain('places_in_home');
    expect(result.review.some((f) => f.message.includes('DEMO MODEL'))).toBe(true);
  });

  it('every step is idempotent', async () => {
    const input = engine.parseInput('unit_revise', sampleReviseInput(goldenUnit2));
    const deps = makeDeps(createDemoLlm());
    let state: JobState = { outputs: {} };
    for (;;) {
      const step = engine.nextStep('unit_revise', input, state);
      if (step === null) break;
      const a = await engine.runStep({ kind: 'unit_revise', input, state, step }, deps);
      const b = await engine.runStep({ kind: 'unit_revise', input, state, step }, deps);
      expect(b.output, step).toEqual(a.output);
      expect(b.result, step).toEqual(a.result);
      state = JSON.parse(
        JSON.stringify({ outputs: { ...state.outputs, [step]: a.output } }),
      ) as JobState;
    }
  });

  it('does not call the model to review when nothing changed', async () => {
    const { run, calls } = await revise(goldenUnit2, () =>
      patch({ summary: 'No change is needed.' }),
    );
    expect(calls.map((c) => c.request.label)).toEqual(['unit_revise:patch']);
    expect(run.result!.changed).toEqual({ section_ids: [], question_ids: [] });
    expect(run.usage).toHaveLength(1);
  });

  it('refuses to revise a project, and a base that does not parse', async () => {
    const project = engine.parseInput('unit_revise', sampleReviseInput(colourChartProject));
    await expect(
      engine.runStep(
        { kind: 'unit_revise', input: project, state: { outputs: {} }, step: 'patch' },
        makeDeps(createDemoLlm()),
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    const broken = engine.parseInput(
      'unit_revise',
      sampleReviseInput({ schema_version: 1, kind: 'lesson' }),
    );
    await expect(
      engine.runStep(
        { kind: 'unit_revise', input: broken, state: { outputs: {} }, step: 'patch' },
        makeDeps(createDemoLlm()),
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('rejects section_ids the unit does not have', async () => {
    const input = engine.parseInput(
      'unit_revise',
      sampleReviseInput(goldenUnit2, 'x', { section_ids: ['nope'] }),
    );
    await expect(
      engine.runStep(
        { kind: 'unit_revise', input, state: { outputs: {} }, step: 'patch' },
        makeDeps(createDemoLlm()),
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('redacts e-mail addresses and phone numbers from the instruction before the model sees it', async () => {
    const { calls } = await revise(
      goldenUnit2,
      () => undefined,
      "Use my cousin's story. Mail ada.obi@example.com or call +234 803 123 4567.",
    );
    const text = String(calls[0]!.request.messages[0]!.content);
    expect(text).not.toContain('ada.obi@example.com');
    expect(text).not.toContain('803 123 4567');
    expect(text).toContain('[email removed]');
  });
});

describe('patches: a patch that omits an old id never drops it', () => {
  it('a patch that touches one section leaves every other id in place', async () => {
    const edit = patch({
      sections: [
        {
          id: 'places_in_school',
          type: '',
          heading: 'Places at School',
          blocks: [block({ type: 'paragraph', text: 'Our school has many places.' })],
          tutor_script: [],
        },
      ],
    });
    const { run } = await revise(goldenUnit2, () => edit);
    const next = parseUnit(run.result!.content);
    expect(ids(next)).toEqual(ids(goldenUnit2));
    expect(run.result!.changed).toEqual({ section_ids: ['places_in_school'], question_ids: [] });
    expect(sectionsOf(next).find((s) => s.id === 'places_in_school')!.heading).toBe(
      'Places at School',
    );
    // the tutor script of the section was not in the patch, so it is kept
    expect(
      sectionsOf(next).find((s) => s.id === 'places_in_school')!.tutor_script?.nodes.length,
    ).toBe(2);
  });

  it('restoreDroppedIds puts back a section and a question a faulty application removed', () => {
    const candidate = toJson(clone(goldenUnit2)) as Record<string, unknown>;
    (candidate['sections'] as unknown[]).splice(2, 1);
    delete (candidate['questions'] as Record<string, unknown>)['wb_keep_clean'];
    const restored = restoreDroppedIds(goldenUnit2, candidate as never);
    const unit = parseUnit(restored.content);
    expect(ids(unit)).toEqual(ids(goldenUnit2));
    expect(sectionsOf(unit)[2]!.id).toBe(sectionsOf(goldenUnit2)[2]!.id);
    expect(restored.notes).toHaveLength(2);
    expect(lintVersionIds(goldenUnit2, unit).ok).toBe(true);
    expect(restoreDroppedIds(goldenUnit2, toJson(goldenUnit2)).notes).toEqual([]);
  });

  it('replaces a question under its own id and keeps the answers note in step', () => {
    const next = applyUnitPatch(
      goldenUnit2,
      patch({
        questions: [
          {
            section_id: '',
            question: question({
              ref: 'wb_fill_cook',
              kind: 'fill_blank',
              tier: 2,
              prompt: 'Fill in the blank. We cook our food in the ____.',
              blanks: [['kitchen', 'the kitchen', 'cooking area']],
            }),
          },
        ],
      }),
    );
    expect(next.issues).toEqual([]);
    const unit = parseUnit(next.content) as LessonUnit;
    expect(unit.questions['wb_fill_cook']).toMatchObject({
      id: 'wb_fill_cook',
      kind: 'fill_blank',
    });
    expect(unit.workbook.answers_note).toMatch(/kitchen/);
    expect(diffUnits(goldenUnit2, unit).question_ids).toEqual(['wb_fill_cook']);
  });

  it('adds a new question under a new id and places it, and joins a new practice question to its tier', () => {
    const next = applyUnitPatch(
      goldenUnit2,
      patch({
        questions: [
          {
            section_id: 'practice_time',
            question: question({
              ref: 'more',
              kind: 'mcq',
              tier: 2,
              prompt: 'Where do we sleep?',
              options: ['bedroom', 'kitchen'],
              answers: ['bedroom'],
            }),
          },
        ],
      }),
    );
    expect(next.issues).toEqual([]);
    const unit = parseUnit(next.content) as LessonUnit;
    expect(unit.questions['q_practice_time_1']).toBeDefined();
    const practice = sectionsOf(unit).find((s) => s.id === 'practice_time')!;
    expect(
      practice.blocks.some((b) => b.type === 'question' && b.question_id === 'q_practice_time_1'),
    ).toBe(true);
    expect(unit.workbook.tiers[1]!.question_ids).toContain('q_practice_time_1');
    expect(next.notes.join(' ')).toMatch(/not placed by any block/);
    expect(lintVersionIds(goldenUnit2, unit).ok).toBe(true);
    expect(diffUnits(goldenUnit2, unit)).toMatchObject({
      section_ids: ['practice_time'],
      question_ids: ['q_practice_time_1'],
    });
  });

  it('adds a new section in unit order and in the session plan, with its manual entry', () => {
    const base = trimmedGolden();
    const next = applyUnitPatch(
      base,
      patch({
        sections: [
          {
            id: 'around_the_world',
            type: 'window_to_world',
            heading: 'Window to the World',
            blocks: [
              block({ type: 'paragraph', text: 'Children everywhere have places to learn.' }),
            ],
            tutor_script: [],
          },
        ],
        manual: {
          script: [
            {
              section_id: 'around_the_world',
              say: 'Read it aloud.',
              ask: 'Where do you learn?',
              watch_for: 'Quiet children.',
            },
          ],
          helper_script: [],
          materials: [],
          got_it: [],
          not_yet_guidance: '',
        },
      }),
    );
    expect(next.issues).toEqual([]);
    const unit = parseUnit(next.content) as LessonUnit;
    const order = sectionsOf(unit).map((s) => s.id);
    expect(order.indexOf('around_the_world')).toBe(order.indexOf('lets_look_together') + 1);
    expect(unit.session_plan.flatMap((p) => p.sections)).toContain('around_the_world');
    expect(unit.teacher_manual.script.some((e) => e.section_id === 'around_the_world')).toBe(true);
    expect(unit.teacher_manual.timing).toMatch(/Window to the World/);
    expect(lintUnit(unit).errors).toEqual([]);
    expect(diffUnits(base, unit).section_ids).toEqual(['around_the_world']);
  });

  it('refuses a seventh-type or repeated enrichment section and a bad id', () => {
    const add = (id: string, type: string) =>
      applyUnitPatch(
        goldenUnit2,
        patch({
          sections: [
            {
              id,
              type,
              heading: 'x',
              blocks: [block({ type: 'paragraph', text: 'x' })],
              tutor_script: [],
            },
          ],
        }),
      );
    expect(add('another_story', 'story_opener').issues.join(' ')).toMatch(/already uses/);
    expect(add('sixth', 'window_to_world').issues.join(' ')).toMatch(/sixth/);
    expect(add('Bad Id', 'concept').issues.join(' ')).toMatch(/valid new id/);
    expect(add('weird', 'quick_fire').issues.join(' ')).toMatch(
      /use concept or an enrichment type/,
    );
  });

  it('keeps a picture and a language tag when a rewritten block says the same thing, and detaches audio when the text changes', () => {
    const base = clone(goldenUnit2);
    const walk = base.sections.find((s) => s.id === 'our_places_walk')!;
    const picture = walk.blocks.find((b) => b.type === 'illustration')!;
    if (picture.type === 'illustration') picture.asset_id = 'abc123';
    walk.audio_refs = ['audio_1'];
    const parsed = parseUnit(toJson(base));
    const keep = applyUnitPatch(
      parsed,
      patch({
        sections: [
          {
            id: 'our_places_walk',
            type: '',
            heading: '',
            blocks: sectionsOfBlocks(parsed, 'our_places_walk'),
            tutor_script: [],
          },
        ],
      }),
    );
    const unchanged = parseUnit(keep.content);
    expect(sectionsOf(unchanged).find((s) => s.id === 'our_places_walk')!.audio_refs).toEqual([
      'audio_1',
    ]);
    const edited = applyUnitPatch(
      parsed,
      patch({
        sections: [
          {
            id: 'our_places_walk',
            type: '',
            heading: '',
            blocks: [
              ...sectionsOfBlocks(parsed, 'our_places_walk').slice(0, 3),
              block({ type: 'paragraph', text: 'Hold hands.' }),
            ],
            tutor_script: [],
          },
        ],
      }),
    );
    const unit = parseUnit(edited.content);
    const section = sectionsOf(unit).find((s) => s.id === 'our_places_walk')!;
    const kept = section.blocks.find((b) => b.type === 'illustration');
    expect(kept === undefined || (kept.type === 'illustration' && kept.asset_id === 'abc123')).toBe(
      true,
    );
    expect(section.audio_refs).toBeUndefined();
    expect(edited.notes.join(' ')).toMatch(/narration audio was detached/);
  });

  it('leaves out parts outside the requested sections', () => {
    const next = applyUnitPatch(
      goldenUnit2,
      patch({
        sections: [
          {
            id: 'come_and_explore',
            type: '',
            heading: 'A new heading',
            blocks: [],
            tutor_script: [],
          },
          {
            id: 'think_deeper',
            type: '',
            heading: 'Different heading',
            blocks: [],
            tutor_script: [],
          },
        ],
        workbook: {
          tier1_title: 'X',
          tier2_title: '',
          tier3_title: '',
          take_it_home: '',
          not_yet: '',
        },
      }),
      { restrictTo: ['come_and_explore'] },
    );
    const unit = parseUnit(next.content);
    expect(diffUnits(goldenUnit2, unit).section_ids).toEqual(['come_and_explore']);
    expect(next.notes.join(' ')).toMatch(/think_deeper was left out/);
    expect(next.notes.join(' ')).toMatch(/Workbook text was left out/);
  });

  it('cannot replace a question of a kind the authoring format cannot express', () => {
    const base = clone(goldenUnit2);
    base.questions['wb_tap'] = {
      id: 'wb_tap',
      kind: 'tap_image',
      tier: 1,
      prompt: 'Tap the kitchen.',
      alt: 'A kitchen',
      brief: 'A kitchen',
      answer: {
        hotspots: [{ id: 'h1', label: 'kitchen', x: 0.1, y: 0.1, w: 0.3, h: 0.3, correct: true }],
      },
    };
    const next = applyUnitPatch(
      parseUnit(toJson(base)),
      patch({
        questions: [
          {
            section_id: '',
            question: question({
              ref: 'wb_tap',
              kind: 'mcq',
              prompt: 'x',
              options: ['a', 'b'],
              answers: ['a'],
            }),
          },
        ],
      }),
    );
    expect(next.notes.join(' ')).toMatch(/cannot be edited here/);
    expect((parseUnit(next.content) as LessonUnit).questions['wb_tap']!.kind).toBe('tap_image');
  });

  it('a patch with an invalid piece is sent back once with the problems, and fails if it is still invalid', async () => {
    const bad = patch({
      sections: [
        {
          id: 'places_in_school',
          type: '',
          heading: '',
          blocks: [block({ type: 'question', question_ref: 'ghost' })],
          tutor_script: [],
        },
      ],
    });
    const calls: ScriptedCall[] = [];
    const llm = scriptedLlm(() => bad, calls);
    const input = engine.parseInput('unit_revise', sampleReviseInput(goldenUnit2));
    await expect(
      engine.runStep(
        { kind: 'unit_revise', input, state: { outputs: {} }, step: 'patch' },
        makeDeps(llm),
      ),
    ).rejects.toMatchObject({ code: 'schema', step: 'patch' });
    expect(calls).toHaveLength(2);
    expect(String(calls[1]!.request.messages.at(-1)!.content)).toMatch(/ghost/);
  });
});

function sectionsOfBlocks(unit: UnitContent, id: string): AuthorBlock[] {
  const section = sectionsOf(unit).find((s) => s.id === id)!;
  return section.blocks.map((b) => {
    const base = block({ type: 'paragraph' });
    switch (b.type) {
      case 'paragraph':
        return { ...base, type: 'paragraph', text: b.text };
      case 'activity_steps':
        return {
          ...base,
          type: 'activity_steps',
          items: b.steps.map((s) => ({ head: s.label, text: s.text })),
        };
      case 'illustration':
        return { ...base, type: 'illustration', brief: b.brief, alt: b.alt };
      default:
        return base;
    }
  });
}

describe('diffUnits', () => {
  it('reports nothing for identical versions and everything that differs otherwise', () => {
    expect(diffUnits(goldenUnit2, goldenUnit2)).toEqual({
      section_ids: [],
      question_ids: [],
      removed_section_ids: [],
      removed_question_ids: [],
      workbook_changed: false,
      manual_changed: false,
      session_plan_changed: false,
      header_changed: false,
    });
    const next = clone(goldenUnit2);
    next.sections[1]!.heading = 'Remember it!';
    next.questions['qf_cook']!.prompt = 'Where is food cooked?';
    next.workbook.take_it_home = 'x';
    next.header.title = 'New title';
    next.sections = next.sections.filter((s) => s.id !== 'think_deeper');
    const diff = diffUnits(goldenUnit2, next);
    expect(diff.section_ids).toEqual(['remember_senses']);
    expect(diff.question_ids).toEqual(['qf_cook']);
    expect(diff.removed_section_ids).toEqual(['think_deeper']);
    expect(diff.workbook_changed && diff.header_changed).toBe(true);
    expect(diff.manual_changed).toBe(false);
  });
});

describe('revise a freshly generated unit', () => {
  it('works on the output of unit_generate end to end', async () => {
    const generated = await runJobToEnd(
      engine,
      'unit_generate',
      engine.parseInput('unit_generate', sampleUnitInput()),
      makeDeps(createDemoLlm()),
    );
    const { run } = await revise(generated.result!.content, () => undefined);
    const base = parseUnit(generated.result!.content);
    const next = parseUnit(run.result!.content);
    expect(ids(next)).toEqual(ids(base));
    expect(run.result!.changed!.section_ids).toEqual(['story_opener']);
    expect(lintVersionIds(base, next).ok).toBe(true);
  });
});
