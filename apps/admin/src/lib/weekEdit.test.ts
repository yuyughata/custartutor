import { describe, expect, it } from 'vitest';
import type { SchemeWeek } from '@custar/content-schema';
import {
  addWeek,
  countByKind,
  hasErrors,
  issuesForRow,
  nextWeekNo,
  normalizeWeeks,
  removeWeek,
  subtopicsToText,
  textToSubtopics,
  updateWeek,
  validateWeeks,
  weeksEqual,
} from './weekEdit';

const weeks: SchemeWeek[] = [
  { week_no: 1, kind: 'teaching', topic: 'Colours', subtopics: ['Red', 'Blue'] },
  { week_no: 2, kind: 'teaching', topic: 'Shapes', subtopics: ['Circle'] },
  { week_no: 3, kind: 'mid_term_exam', topic: 'MID-TERM EXAMINATION', subtopics: [] },
];

describe('editing rows', () => {
  it('adds a teaching week with the smallest free week number', () => {
    expect(nextWeekNo(weeks)).toBe(4);
    expect(nextWeekNo([{ ...weeks[1]! }])).toBe(1);
    const added = addWeek(weeks);
    expect(added).toHaveLength(4);
    expect(added[3]).toEqual({ week_no: 4, kind: 'teaching', topic: '', subtopics: [] });
    expect(weeks).toHaveLength(3);
  });

  it('removes and updates a row without touching the original', () => {
    expect(removeWeek(weeks, 1).map((w) => w.week_no)).toEqual([1, 3]);
    const updated = updateWeek(weeks, 0, { topic: 'Colour identification' });
    expect(updated[0]?.topic).toBe('Colour identification');
    expect(weeks[0]?.topic).toBe('Colours');
  });

  it('edits subtopics as lines and keeps a trailing blank line while typing', () => {
    expect(subtopicsToText(['a', 'b'])).toBe('a\nb');
    expect(textToSubtopics('a\nb\n')).toEqual(['a', 'b', '']);
    expect(textToSubtopics('')).toEqual([]);
  });
});

describe('normalizeWeeks and weeksEqual', () => {
  it('trims, drops blank subtopics and sorts', () => {
    const messy: SchemeWeek[] = [
      { week_no: 3, kind: 'teaching', topic: '  Shapes  ', subtopics: ['  Circle ', '', '   '] },
      { week_no: 1, kind: 'teaching', topic: 'Colours', subtopics: [] },
    ];
    expect(normalizeWeeks(messy)).toEqual([
      { week_no: 1, kind: 'teaching', topic: 'Colours', subtopics: [] },
      { week_no: 3, kind: 'teaching', topic: 'Shapes', subtopics: ['Circle'] },
    ]);
  });

  it('detects unsaved changes ignoring whitespace and order', () => {
    expect(weeksEqual(weeks, [...weeks].reverse())).toBe(true);
    expect(weeksEqual(weeks, updateWeek(weeks, 0, { topic: 'Colours ' }))).toBe(true);
    expect(weeksEqual(weeks, updateWeek(weeks, 0, { topic: 'Colors' }))).toBe(false);
    expect(weeksEqual(weeks, removeWeek(weeks, 2))).toBe(false);
  });
});

describe('validateWeeks', () => {
  it('accepts a good table', () => {
    expect(validateWeeks(weeks)).toEqual([]);
    expect(hasErrors(validateWeeks(weeks))).toBe(false);
  });

  it('needs at least one week and one teaching week', () => {
    expect(validateWeeks([])[0]).toMatchObject({ severity: 'error', field: 'scheme' });
    const none = validateWeeks([weeks[2] as SchemeWeek]);
    expect(none.some((i) => i.severity === 'error' && /teaching week/.test(i.message))).toBe(true);
  });

  it('flags duplicate, out-of-range and blank rows', () => {
    const issues = validateWeeks([
      { week_no: 1, kind: 'teaching', topic: 'A', subtopics: ['x'] },
      { week_no: 1, kind: 'teaching', topic: 'B', subtopics: ['x'] },
      { week_no: 21, kind: 'teaching', topic: 'C', subtopics: ['x'] },
      { week_no: 4, kind: 'teaching', topic: '   ', subtopics: ['x'] },
    ]);
    expect(issuesForRow(issues, 1)[0]?.message).toBe('Week 1 appears twice.');
    expect(issuesForRow(issues, 2).some((i) => /whole number from 1 to 20/.test(i.message))).toBe(true);
    expect(issuesForRow(issues, 3).some((i) => i.field === 'topic')).toBe(true);
    expect(hasErrors(issues)).toBe(true);
  });

  it('warns, without blocking, about teaching weeks that cannot become units or have no subtopics', () => {
    const issues = validateWeeks([
      { week_no: 1, kind: 'teaching', topic: 'A', subtopics: [] },
      { week_no: 16, kind: 'teaching', topic: 'B', subtopics: ['x', ''] },
    ]);
    expect(issues.every((i) => i.severity === 'warning')).toBe(true);
    expect(issues.map((i) => i.message).join(' ')).toMatch(/No subtopics/);
    expect(issues.map((i) => i.message).join(' ')).toMatch(/after week 15/);
    expect(issues.map((i) => i.message).join(' ')).toMatch(/Blank subtopic lines/);
  });

  it('counts teaching and other weeks', () => {
    expect(countByKind(weeks)).toEqual({ teaching: 2, other: 1 });
  });
});
