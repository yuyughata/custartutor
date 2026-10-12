import { describe, expect, it } from 'vitest';
import { goldenUnit2 } from '@custar/content-schema/fixtures';
import { Id, parseUnit, type UnitContent } from '@custar/content-schema';
import {
  addBlock,
  addMissingScriptRows,
  addSegment,
  addStep,
  moveStep,
  removeStep,
  renumberSteps,
  setEvidence,
  addNode,
  addPeriod,
  addQuestion,
  addSection,
  addTier,
  addVariant,
  duplicateBlock,
  duplicateQuestion,
  duplicateSection,
  moveBlock,
  missingSegments,
  moveSection,
  periodMinutes,
  questionIds,
  questionUsage,
  questionsNotInSections,
  removeBlock,
  removeNode,
  removePeriod,
  removeQuestion,
  removeSection,
  sectionUsage,
  sections,
  sectionsOutsidePlan,
  setPeriodSection,
  setSectionType,
} from './ops';
import { getAt, listAt, setAt } from './path';

const gold = goldenUnit2 as UnitContent;
const none = new Set<string>();

function ids(unit: UnitContent): string[] {
  return sections(unit).map((s) => String(s.id));
}

describe('sections', () => {
  it('adds a section with a generated id, the layer of its type and one empty paragraph', () => {
    const { unit, id } = addSection(gold, 'practice', none);
    expect(id).toBe('practice_1');
    const added = sections(unit).at(-1)!;
    expect(added).toMatchObject({ id: 'practice_1', type: 'practice', layer: 'CORE', heading: '' });
    expect(listAt(added, ['blocks'])).toEqual([{ type: 'paragraph', text: '' }]);
    // the next one of the same type does not collide
    expect(addSection(unit, 'practice', none).id).toBe('practice_2');
    // nor with an id that was ever published
    expect(addSection(gold, 'practice', new Set(['practice_1'])).id).toBe('practice_2');
  });

  it('adds after a given section', () => {
    const { unit } = addSection(gold, 'concept', none, 0);
    expect(ids(unit)[1]).toBe('concept_1');
  });

  it('changing the type changes the layer, never the id', () => {
    const next = setSectionType(gold, 0, 'concept');
    expect(getAt(next, ['sections', 0, 'layer'])).toBe('CORE');
    expect(getAt(next, ['sections', 0, 'id'])).toBe('come_and_explore');
  });

  it('moves sections', () => {
    const moved = moveSection(gold, 0, 2);
    expect(ids(moved).slice(0, 3)).toEqual(ids(gold).slice(1, 3).concat(ids(gold)[0] as string));
  });

  it('removing a section takes its references out of the plan and the manual, and says so', () => {
    const index = ids(gold).indexOf('places_in_school');
    expect(sectionUsage(gold, 'places_in_school').length).toBeGreaterThan(1);
    const { unit, notes } = removeSection(gold, index);
    expect(ids(unit)).not.toContain('places_in_school');
    expect(JSON.stringify(getAt(unit, ['session_plan']))).not.toContain('places_in_school');
    expect(JSON.stringify(getAt(unit, ['teacher_manual']))).not.toContain('"places_in_school"');
    expect(notes.length).toBeGreaterThanOrEqual(2);
    // the original is untouched
    expect(ids(gold)).toContain('places_in_school');
  });

  it('duplicating a section copies its questions under fresh ids and rewires the copy', () => {
    const index = ids(gold).indexOf('practice_time');
    const { unit, id } = duplicateSection(gold, index, none);
    expect(id).toBe('practice_1');
    const copy = sections(unit)[index + 1]!;
    expect(copy.heading).toBe(`${String(sections(gold)[index]!.heading)} (copy)`);
    const original = listAt<{ type: string; question_id?: string }>(sections(gold)[index]!, ['blocks'])
      .filter((b) => b.type === 'question')
      .map((b) => b.question_id);
    const copied = listAt<{ type: string; question_id?: string }>(copy, ['blocks'])
      .filter((b) => b.type === 'question')
      .map((b) => b.question_id);
    expect(copied).toHaveLength(original.length);
    expect(copied.some((q) => original.includes(q))).toBe(false);
    for (const q of copied) expect(questionIds(unit)).toContain(q);
    expect(questionIds(unit).length).toBe(questionIds(gold).length + original.length);
    // every id is unique and valid
    const all = [...ids(unit), ...questionIds(unit)];
    expect(new Set(all).size).toBe(all.length);
    for (const one of all) expect(Id.safeParse(one).success).toBe(true);
  });

  it('duplicating rewires a tutor line that waits for a copied question', () => {
    const withScript = setAt(gold, ['sections', 0, 'tutor_script'], {
      nodes: [{ id: 'n_a', say: 'Try it', expect: { question_id: 'mc_places' }, on_correct: [], on_incorrect: [], hint: [] }],
    });
    const withBlock = setAt(withScript, ['sections', 0, 'blocks'], [
      ...listAt(withScript, ['sections', 0, 'blocks']),
      { type: 'question', question_id: 'mc_places' },
    ]);
    const { unit } = duplicateSection(withBlock, 0, none);
    const copyExpect = getAt(unit, ['sections', 1, 'tutor_script', 'nodes', 0, 'expect', 'question_id']);
    expect(copyExpect).not.toBe('mc_places');
    expect(questionIds(unit)).toContain(String(copyExpect));
    expect(getAt(unit, ['sections', 0, 'tutor_script', 'nodes', 0, 'expect', 'question_id'])).toBe('mc_places');
  });
});

describe('blocks', () => {
  it('adds, moves, duplicates and removes', () => {
    const added = addBlock(gold, 0, 'callout');
    const blocks = listAt<{ type: string }>(added, ['sections', 0, 'blocks']);
    expect(blocks.at(-1)).toEqual({ type: 'callout', tone: 'info', text: '' });
    expect(blocks).toHaveLength(listAt(gold, ['sections', 0, 'blocks']).length + 1);
    const first = addBlock(gold, 0, 'definition', 0);
    expect(getAt(first, ['sections', 0, 'blocks', 0, 'type'])).toBe('definition');

    const moved = moveBlock(gold, 0, 0, 1);
    expect(getAt(moved, ['sections', 0, 'blocks', 1])).toEqual(getAt(gold, ['sections', 0, 'blocks', 0]));

    const doubled = duplicateBlock(gold, 0, 0);
    expect(getAt(doubled, ['sections', 0, 'blocks', 1])).toEqual(getAt(gold, ['sections', 0, 'blocks', 0]));
    expect(getAt(doubled, ['sections', 0, 'blocks', 1])).not.toBe(getAt(gold, ['sections', 0, 'blocks', 0]));

    const gone = removeBlock(gold, 0, 0);
    expect(listAt(gone, ['sections', 0, 'blocks'])).toHaveLength(listAt(gold, ['sections', 0, 'blocks']).length - 1);
  });

  it('does not duplicate a question block', () => {
    const withQuestion = addQuestion(gold, 'mcq', none, { sectionIndex: 0 });
    const last = listAt(withQuestion.unit, ['sections', 0, 'blocks']).length - 1;
    expect(duplicateBlock(withQuestion.unit, 0, last)).toBe(withQuestion.unit);
  });
});

describe('questions', () => {
  it('adds a question and places it in a section when asked', () => {
    const { unit, id } = addQuestion(gold, 'mcq', none, { sectionIndex: 1, tier: 2 });
    expect(id).toBe('q_mcq_1');
    expect(getAt(unit, ['questions', id])).toMatchObject({ id, kind: 'mcq', tier: 2 });
    expect(listAt<{ question_id?: string }>(unit, ['sections', 1, 'blocks']).at(-1)).toEqual({
      type: 'question',
      question_id: id,
    });
    expect(questionsNotInSections(addQuestion(gold, 'draw', none).unit)).toContain('q_draw_1');
  });

  it('duplicates a question right after the original, with a fresh id', () => {
    const { unit, id } = duplicateQuestion(gold, 'wb_match_places', none);
    const keys = questionIds(unit);
    expect(keys[keys.indexOf('wb_match_places') + 1]).toBe(id);
    expect(getAt(unit, ['questions', id, 'id'])).toBe(id);
    expect(getAt(unit, ['questions', id, 'prompt'])).toBe(getAt(gold, ['questions', 'wb_match_places', 'prompt']));
    expect(duplicateQuestion(gold, 'nope', none).id).toBe('');
  });

  it('removing a question removes every reference to it', () => {
    const usedBefore = questionUsage(gold, 'wb_match_places');
    expect(usedBefore.some((u) => u.startsWith('workbook tier'))).toBe(true);
    const { unit, notes } = removeQuestion(gold, 'wb_match_places');
    expect(questionIds(unit)).not.toContain('wb_match_places');
    expect(questionUsage(unit, 'wb_match_places')).toEqual([]);
    expect(JSON.stringify(unit)).not.toContain('wb_match_places');
    expect(notes.length).toBeGreaterThan(0);
  });

  it('removing the application task asks for another, and a waited-for question frees the tutor line', () => {
    const { unit } = removeQuestion(gold, 'wb_application');
    expect(getAt(unit, ['workbook', 'application_task_id'])).toBe('');
    const script = setAt(gold, ['sections', 0, 'tutor_script', 'nodes', 0, 'expect'], { question_id: 'mc_places' });
    const result = removeQuestion(script, 'mc_places');
    expect(getAt(result.unit, ['sections', 0, 'tutor_script', 'nodes', 0, 'expect'])).toBeUndefined();
    expect(result.notes.join(' ')).toContain('tutor');
  });

  it('removing a question that is not there does nothing', () => {
    expect(removeQuestion(gold, 'nope')).toEqual({ unit: gold, notes: [] });
  });
});

describe('tutor script', () => {
  it('adds a node with a free id, creating the script if there is none', () => {
    const withoutScript = setAt(gold, ['sections', 2], { ...sections(gold)[2], tutor_script: undefined });
    const { unit, id } = addNode(withoutScript, 2, none);
    expect(id).toBe('n_1');
    expect(getAt(unit, ['sections', 2, 'tutor_script', 'nodes', 0, 'id'])).toBe('n_1');
    const again = addNode(unit, 2, none);
    expect(again.id).toBe('n_2');
  });

  it('removing a node frees the lines that jumped to it, and the last node removes the script', () => {
    const script = {
      nodes: [
        { id: 'a', say: 'a', next: 'b', on_correct: [], on_incorrect: [], hint: [] },
        { id: 'b', say: 'b', on_correct: [], on_incorrect: [], hint: [] },
      ],
    };
    const unit = setAt(gold, ['sections', 0, 'tutor_script'], script);
    const removed = removeNode(unit, 0, 1);
    expect(getAt(removed.unit, ['sections', 0, 'tutor_script', 'nodes', 0, 'next'])).toBeUndefined();
    expect(removed.notes.join(' ')).toContain('continue in order');
    const last = removeNode(removed.unit, 0, 0);
    expect(getAt(last.unit, ['sections', 0, 'tutor_script'])).toBeUndefined();
  });
});

describe('session plan, workbook and manual', () => {
  it('adds a period of 60 minutes and renumbers after a removal', () => {
    const added = addPeriod(gold);
    expect(listAt(added, ['session_plan'])).toHaveLength(3);
    expect(periodMinutes(added, 2)).toBe(60);
    const removed = removePeriod(added, 0);
    expect(listAt<{ period: number }>(removed, ['session_plan']).map((p) => p.period)).toEqual([1, 2]);
  });

  it('knows which sections are in no period', () => {
    expect(sectionsOutsidePlan(gold)).toEqual([]);
    expect(sectionsOutsidePlan(addSection(gold, 'concept', none).unit)).toEqual(['concept_1']);
  });

  it('adds missing tiers and practice sets', () => {
    const noTier = setAt(gold, ['workbook', 'tiers'], listAt(gold, ['workbook', 'tiers']).slice(0, 2));
    expect(listAt(addTier(noTier, 3), ['workbook', 'tiers'])).toHaveLength(3);
    expect(addTier(gold, 2)).toBe(gold);
    const { unit, id } = addVariant(gold, none);
    expect(id).toBe('variant_1');
    expect(listAt(unit, ['workbook', 'practice_variants'])).toHaveLength(3);
  });

  it('adds a script row for every section that lacks one', () => {
    const grown = addSection(gold, 'concept', none).unit;
    const filled = addMissingScriptRows(grown);
    expect(listAt(filled, ['teacher_manual', 'script']).at(-1)).toMatchObject({ section_id: 'concept_1', say: '' });
    expect(addMissingScriptRows(filled)).toBe(filled);
  });
});

describe('session plan periods', () => {
  it('puts a section into a period and takes it out, in textbook order', () => {
    const first = String(sections(gold)[0]?.id);
    const without = setPeriodSection(gold, 0, first, false);
    expect(listAt<string>(without, ['session_plan', 0, 'sections'])).not.toContain(first);
    const back = setPeriodSection(without, 0, first, true);
    const list = listAt<string>(back, ['session_plan', 0, 'sections']);
    expect(list).toContain(first);
    const order = ids(gold);
    expect(list.map((id) => order.indexOf(id))).toEqual([...list.map((id) => order.indexOf(id))].sort((a, b) => a - b));
  });

  it('keeps an id that is not a section at the end, so it can be seen and unticked', () => {
    const leftover = setAt(gold, ['session_plan', 0, 'sections'], [...listAt<string>(gold, ['session_plan', 0, 'sections']), 'gone_section']);
    const touched = setPeriodSection(leftover, 0, String(sections(gold)[0]?.id), true);
    expect(listAt<string>(touched, ['session_plan', 0, 'sections']).at(-1)).toBe('gone_section');
    const removed = setPeriodSection(touched, 0, 'gone_section', false);
    expect(listAt<string>(removed, ['session_plan', 0, 'sections'])).not.toContain('gone_section');
  });

  it('adds a missing segment once', () => {
    const fewer = setAt(gold, ['session_plan', 0, 'minutes'], listAt(gold, ['session_plan', 0, 'minutes']).slice(0, 3));
    expect(missingSegments(fewer, 0)).toEqual(['practice', 'close']);
    const more = addSegment(fewer, 0, 'close');
    expect(listAt(more, ['session_plan', 0, 'minutes'])).toHaveLength(4);
    expect(addSegment(more, 0, 'close')).toBe(more);
    expect(addSegment(more, 0, 'nonsense')).toBe(more);
  });
});

describe('project steps and evidence', () => {
  const project = {
    kind: 'mini_project',
    steps: [
      { n: 1, text: 'one' },
      { n: 2, text: 'two' },
      { n: 3, text: 'three' },
    ],
    evidence_options: ['photo', 'text'],
  } as unknown as UnitContent;

  it('renumbers after every change so the steps always read 1, 2, 3', () => {
    const moved = moveStep(project, 2, 0);
    expect(listAt(moved, ['steps']).map((s) => (s as { n: number; text: string }).text)).toEqual(['three', 'one', 'two']);
    expect(listAt(moved, ['steps']).map((s) => (s as { n: number }).n)).toEqual([1, 2, 3]);
    const removed = removeStep(project, 0);
    expect(listAt(removed, ['steps']).map((s) => (s as { n: number }).n)).toEqual([1, 2]);
    const added = addStep(project);
    expect(listAt(added, ['steps']).at(-1)).toEqual({ n: 4, text: '' });
    expect(renumberSteps(project)).toEqual(project);
  });

  it('never removes the last step', () => {
    const one = removeStep(removeStep(project, 0), 0);
    expect(listAt(one, ['steps'])).toHaveLength(1);
    expect(removeStep(one, 0)).toBe(one);
  });

  it('keeps the evidence choices in a fixed order and never empty', () => {
    expect(getAt(setEvidence(project, 'audio', true), ['evidence_options'])).toEqual(['photo', 'audio', 'text']);
    expect(getAt(setEvidence(project, 'photo', false), ['evidence_options'])).toEqual(['text']);
    const single = setEvidence(project, 'photo', false);
    expect(getAt(setEvidence(single, 'text', false), ['evidence_options'])).toEqual(['text']);
  });
});

describe('the golden unit through the operations', () => {
  it('still parses after harmless operations', () => {
    let unit: UnitContent = gold;
    unit = moveSection(unit, 0, 1);
    unit = moveSection(unit, 1, 0);
    unit = duplicateSection(unit, 3, none).unit;
    expect(() => parseUnit(unit)).not.toThrow();
  });
});
