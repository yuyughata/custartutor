import { describe, expect, it } from 'vitest';
import { goldenUnit2 } from '@custar/content-schema/fixtures';
import { jumpTarget, parsePath } from './lintPaths';

describe('parsePath', () => {
  it('splits dotted and indexed paths', () => {
    expect(parsePath('sections[3].blocks[1]')).toEqual(['sections', 3, 'blocks', 1]);
    expect(parsePath('questions.q_name.answer')).toEqual(['questions', 'q_name', 'answer']);
    expect(parsePath('questions["q-1"].answer')).toEqual(['questions', 'q-1', 'answer']);
    expect(parsePath('')).toEqual([]);
  });
});

describe('jumpTarget', () => {
  const sections = goldenUnit2.sections;

  it('points a section index at its heading', () => {
    const target = jumpTarget('sections[2].blocks[0]', goldenUnit2);
    expect(target).toMatchObject({
      tab: 'textbook',
      heading: sections[2]!.heading,
      sectionId: sections[2]!.id,
      label: `Section 3: ${sections[2]!.heading}`,
    });
  });

  it('points a section id at its heading', () => {
    const id = sections[4]!.id;
    expect(jumpTarget(`sections.${id}`, goldenUnit2)).toMatchObject({
      heading: sections[4]!.heading,
    });
  });

  it('falls back to the textbook tab when the section is unknown', () => {
    expect(jumpTarget('sections[99]', goldenUnit2)).toEqual({ tab: 'textbook', label: 'Textbook' });
    expect(jumpTarget('sections.nope', goldenUnit2)).toEqual({
      tab: 'textbook',
      label: 'Textbook',
    });
  });

  it('finds the section that holds a question', () => {
    const withQuestion = sections.find((s) => s.blocks.some((b) => b.type === 'question'));
    const block = withQuestion?.blocks.find((b) => b.type === 'question');
    expect(withQuestion && block && block.type === 'question').toBe(true);
    if (withQuestion && block && block.type === 'question') {
      expect(jumpTarget(`questions.${block.question_id}.answer`, goldenUnit2)).toMatchObject({
        tab: 'textbook',
        heading: withQuestion.heading,
      });
    }
    expect(jumpTarget('questions.not_placed', goldenUnit2)).toEqual({
      tab: 'workbook',
      label: 'Workbook',
    });
  });

  it('maps workbook, manual, plan and header', () => {
    expect(jumpTarget('workbook.tiers', goldenUnit2)).toEqual({
      tab: 'workbook',
      label: 'Workbook',
    });
    expect(jumpTarget('teacher_manual.materials', goldenUnit2)).toEqual({
      tab: 'manual',
      label: "Teacher's manual",
    });
    expect(jumpTarget('session_plan[0]', goldenUnit2)?.tab).toBe('manual');
    expect(jumpTarget('header.objective', goldenUnit2)).toEqual({
      tab: 'textbook',
      label: 'Unit header',
    });
  });

  it('returns null for no path or an unknown area', () => {
    expect(jumpTarget(undefined, goldenUnit2)).toBeNull();
    expect(jumpTarget('mystery.thing', goldenUnit2)).toBeNull();
  });
});
