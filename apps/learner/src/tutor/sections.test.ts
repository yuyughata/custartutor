import { describe, expect, it } from 'vitest';
import { parseUnit, sectionsOf, type UnitContent } from '@custar/content-schema';
import { colourChartProject, goldenUnit2 } from '@custar/content-schema/fixtures';
import {
  UNIT_SCRIPT_ID,
  activityInfo,
  defaultLiteTarget,
  liteTargets,
  positionFor,
  sectionOfQuestion,
  splitBold,
} from './sections';

const golden = parseUnit(goldenUnit2);
const project = parseUnit(colourChartProject);

function firstQuestionOf(sectionId: string): string {
  const section = sectionsOf(golden).find((candidate) => candidate.id === sectionId);
  const block = section?.blocks.find((candidate) => candidate.type === 'question');
  if (!block || block.type !== 'question') throw new Error(`no question in ${sectionId}`);
  return block.question_id;
}

describe('liteTargets', () => {
  it('lists the sections that have a tutor_script, in lesson order', () => {
    const targets = liteTargets(golden);
    const expected = sectionsOf(golden)
      .filter((section) => section.tutor_script)
      .map((section) => section.id);
    expect(targets.map((t) => t.sectionId)).toEqual(expected);
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.every((t) => t.script.nodes.length > 0 && t.heading.length > 0)).toBe(true);
  });

  it('offers a project its unit-level script', () => {
    const targets = liteTargets(project);
    expect(targets[0]?.sectionId).toBe(UNIT_SCRIPT_ID);
    expect(targets[0]?.heading).toBe(project.header.title);
  });
});

describe('sectionOfQuestion / defaultLiteTarget / positionFor', () => {
  it('finds the section that holds a question', () => {
    const questionId = firstQuestionOf('practice_time');
    expect(sectionOfQuestion(golden, questionId)).toBe('practice_time');
    expect(sectionOfQuestion(golden, 'nope')).toBeNull();
  });

  it('defaults to the part of the last question, only if that part has a script', () => {
    const questionId = firstQuestionOf('practice_time');
    // In the fixture the practice part has no script, so the child is asked which part instead.
    expect(defaultLiteTarget(golden, questionId)).toBeNull();

    const scripted: UnitContent = structuredClone(golden);
    const practice = sectionsOf(scripted).find((section) => section.id === 'practice_time');
    if (!practice) throw new Error('missing section');
    practice.tutor_script = {
      nodes: [{ id: 'n1', say: 'Ready?', on_correct: [], on_incorrect: [], hint: [] }],
    };
    expect(defaultLiteTarget(scripted, questionId)?.sectionId).toBe('practice_time');
    expect(defaultLiteTarget(golden, null)).toBeNull();
    expect(defaultLiteTarget(golden, 'nope')).toBeNull();
  });

  it('gives the tutor the position of the last question', () => {
    const questionId = firstQuestionOf('practice_time');
    expect(positionFor(golden, questionId)).toEqual({
      questionId,
      sectionId: 'practice_time',
    });
    expect(positionFor(golden, null)).toEqual({});
  });
});

describe('activityInfo', () => {
  it('returns the prompt and where it lives for a practice question', () => {
    const questionId = firstQuestionOf('practice_time');
    const info = activityInfo(golden, questionId);
    expect(info?.questionId).toBe(questionId);
    expect(info?.prompt.length).toBeGreaterThan(0);
    expect(info?.where).toBeTruthy();
  });

  it('never shows a mastery-check question, whatever the tutor suggests', () => {
    const mastery = sectionsOf(golden).find((section) => section.type === 'mastery_check');
    const block = mastery?.blocks.find((candidate) => candidate.type === 'question');
    if (!block || block.type !== 'question') throw new Error('golden unit has no mastery question');
    expect(activityInfo(golden, block.question_id)).toBeNull();
  });

  it('ignores a question that is not in the unit', () => {
    expect(activityInfo(golden, 'not_a_question')).toBeNull();
  });
});

describe('splitBold', () => {
  it('splits **bold** runs and drops the markers', () => {
    expect(splitBold('We learn in the **classroom** today.')).toEqual([
      { text: 'We learn in the ', bold: false },
      { text: 'classroom', bold: true },
      { text: ' today.', bold: false },
    ]);
    expect(splitBold('no markers')).toEqual([{ text: 'no markers', bold: false }]);
    expect(splitBold('')).toEqual([{ text: '', bold: false }]);
  });
});
