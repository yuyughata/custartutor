import { describe, expect, it } from 'vitest';
import { ownerOf, remainder } from './owners';

describe('ownerOf', () => {
  it('keeps a path as deep as the editor draws a field', () => {
    expect(ownerOf(['header', 'objective'])).toEqual(['header', 'objective']);
    expect(ownerOf(['header', 'theme', 'lens'])).toEqual(['header', 'theme', 'lens']);
    expect(ownerOf(['sections', 3, 'heading'])).toEqual(['sections', 3, 'heading']);
    expect(ownerOf(['sections', 3, 'blocks', 1, 'items', 0, 'text'])).toEqual([
      'sections',
      3,
      'blocks',
      1,
      'items',
      0,
      'text',
    ]);
    expect(ownerOf(['sections', 0, 'tutor_script', 'nodes', 2, 'hint', 1])).toEqual([
      'sections',
      0,
      'tutor_script',
      'nodes',
      2,
      'hint',
      1,
    ]);
    expect(ownerOf(['workbook', 'tiers', 1, 'question_ids', 0])).toEqual([
      'workbook',
      'tiers',
      1,
      'question_ids',
      0,
    ]);
    expect(ownerOf(['teacher_manual', 'script', 4, 'say'])).toEqual([
      'teacher_manual',
      'script',
      4,
      'say',
    ]);
  });

  it('cuts a path that goes deeper than any field', () => {
    expect(ownerOf(['sections', 3, 'blocks', 1, 'rows', 2, 0, 'extra', 'deeper'])).toHaveLength(8);
    expect(ownerOf(['header', 'theme', 'lens', 'x'])).toEqual(['header', 'theme', 'lens']);
  });

  it("shows a question's whole answer in one place", () => {
    expect(ownerOf(['questions', 'q_a', 'answer', 'blanks', 1, 'accepted', 0])).toEqual([
      'questions',
      'q_a',
      'answer',
    ]);
    expect(ownerOf(['questions', 'q_a', 'prompt'])).toEqual(['questions', 'q_a', 'prompt']);
    expect(ownerOf(['questions', 'q_a', 'options', 2])).toEqual(['questions', 'q_a', 'options', 2]);
  });

  it('handles the odd cases', () => {
    expect(ownerOf([])).toEqual([]);
    expect(ownerOf(['kind'])).toEqual(['kind']);
    expect(ownerOf(['unknown_part', 'a', 'b'])).toEqual(['unknown_part', 'a']);
  });

  it('says what was cut', () => {
    const path = ['questions', 'q_a', 'answer', 'blanks', 1, 'accepted', 0];
    expect(remainder(path, ownerOf(path))).toBe('blanks[2].accepted[1]');
    expect(remainder(['header', 'title'], ['header', 'title'])).toBe('');
  });
});
