import { describe, expect, it } from 'vitest';
import { Scheme, groupIntoChapters } from './scheme';
import type { SchemeWeek, WeekKind } from './scheme';

function weeks(spec: [number, WeekKind][]): SchemeWeek[] {
  return spec.map(([week_no, kind]) => ({
    week_no,
    kind,
    topic: `Topic ${week_no}`,
    subtopics: [`Subtopic ${week_no}`],
  }));
}

function teachingScheme(count: number): Scheme {
  return {
    subject_slug: 'basic-science',
    level_code: 'P1',
    term: 1,
    weeks: weeks(Array.from({ length: count }, (_, i): [number, WeekKind] => [i + 1, 'teaching'])),
  };
}

const sizes = (scheme: Scheme, options?: { min?: number; max?: number }) =>
  groupIntoChapters(scheme, options).chapters.map((chapter) => chapter.week_nos.length);

describe('groupIntoChapters', () => {
  it('splits 8 teaching weeks into 4 + 4 (the P1 Basic Science shape)', () => {
    const scheme: Scheme = {
      subject_slug: 'basic-science',
      level_code: 'P1',
      term: 1,
      weeks: weeks([
        [1, 'teaching'],
        [2, 'teaching'],
        [3, 'teaching'],
        [4, 'teaching'],
        [5, 'mid_term_exam'],
        [6, 'break'],
        [7, 'teaching'],
        [8, 'teaching'],
        [9, 'teaching'],
        [10, 'teaching'],
        [11, 'revision'],
        [12, 'exam'],
        [13, 'closing'],
      ]),
    };
    const { chapters, warnings } = groupIntoChapters(scheme);
    expect(warnings).toEqual([]);
    expect(chapters.map((c) => c.week_nos)).toEqual([
      [1, 2, 3, 4],
      [7, 8, 9, 10],
    ]);
    expect(chapters.map((c) => c.chapter_no)).toEqual([1, 2]);
    expect(chapters[1]?.topics).toEqual(['Topic 7', 'Topic 8', 'Topic 9', 'Topic 10']);
  });

  it.each([
    [3, [3]],
    [4, [4]],
    [5, [5]],
    [6, [3, 3]],
    [7, [4, 3]],
    [8, [4, 4]],
    [9, [4, 5]],
    [10, [4, 3, 3]],
    [11, [4, 4, 3]],
    [12, [4, 4, 4]],
    [13, [4, 4, 5]],
    [14, [4, 4, 3, 3]],
  ])('groups %i teaching weeks into %j', (count, expected) => {
    expect(sizes(teachingScheme(count))).toEqual(expected);
  });

  it('keeps every chapter within 3 to 5 units for any number of weeks from 3 to 60', () => {
    for (let count = 3; count <= 60; count += 1) {
      const { chapters, warnings } = groupIntoChapters(teachingScheme(count));
      expect(warnings).toEqual([]);
      for (const chapter of chapters) {
        expect(chapter.week_nos.length).toBeGreaterThanOrEqual(3);
        expect(chapter.week_nos.length).toBeLessThanOrEqual(5);
      }
      // every teaching week appears exactly once, in order
      expect(chapters.flatMap((c) => c.week_nos)).toEqual(
        Array.from({ length: count }, (_, i) => i + 1),
      );
    }
  });

  it('skips exam, break, revision and closing weeks and never lists them', () => {
    const scheme: Scheme = {
      subject_slug: 'x',
      level_code: 'P2',
      term: 2,
      weeks: weeks([
        [1, 'teaching'],
        [2, 'break'],
        [3, 'teaching'],
        [4, 'exam'],
        [5, 'teaching'],
        [6, 'revision'],
        [7, 'closing'],
      ]),
    };
    expect(groupIntoChapters(scheme).chapters.map((c) => c.week_nos)).toEqual([[1, 3, 5]]);
  });

  it('orders by week number and does not mutate its input', () => {
    const scheme = teachingScheme(6);
    scheme.weeks.reverse();
    const before = JSON.stringify(scheme);
    const { chapters } = groupIntoChapters(scheme);
    expect(chapters.map((c) => c.week_nos)).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
    expect(JSON.stringify(scheme)).toBe(before);
  });

  it('warns, rather than inventing a chapter, when a term has too few teaching weeks', () => {
    const result = groupIntoChapters(teachingScheme(2));
    expect(result.chapters).toHaveLength(1);
    expect(result.chapters[0]?.week_nos).toEqual([1, 2]);
    expect(result.warnings).toHaveLength(1);
    expect(groupIntoChapters(teachingScheme(0))).toEqual({ chapters: [], warnings: [] });
  });

  it('honours custom bounds, falling back to an even split when greedy cannot fit', () => {
    expect(sizes(teachingScheme(7), { min: 2, max: 3 })).toEqual([3, 2, 2]);
    // greedy would give 5 + 5 + 2, and the 2-week tail cannot merge or rebalance within 4-6
    expect(sizes(teachingScheme(12), { min: 4, max: 6 })).toEqual([6, 6]);
    for (let count = 4; count <= 40; count += 1) {
      const { chapters, warnings } = groupIntoChapters(teachingScheme(count), { min: 4, max: 6 });
      if (warnings.length === 0) {
        for (const chapter of chapters) {
          expect(chapter.week_nos.length).toBeGreaterThanOrEqual(4);
          expect(chapter.week_nos.length).toBeLessThanOrEqual(6);
        }
      }
    }
    expect(sizes(teachingScheme(9), { min: 4, max: 6 })).toEqual([5, 4]);
  });

  it('warns when no grouping can satisfy the bounds', () => {
    // 7 weeks into chapters of 4 or 5: 4+3 and 7 are both outside, so no valid grouping exists
    const result = groupIntoChapters(teachingScheme(7), { min: 4, max: 5 });
    expect(result.chapters.flatMap((c) => c.week_nos)).toHaveLength(7);
    expect(result.warnings).toHaveLength(1);
  });

  it('rejects impossible bounds', () => {
    expect(() => groupIntoChapters(teachingScheme(8), { min: 5, max: 3 })).toThrow(RangeError);
    expect(() => groupIntoChapters(teachingScheme(8), { min: 0, max: 3 })).toThrow(RangeError);
  });
});

describe('Scheme schema', () => {
  it('rejects duplicate week numbers and unknown week kinds', () => {
    const base = teachingScheme(2);
    expect(Scheme.safeParse(base).success).toBe(true);
    const duplicate = { ...base, weeks: [...base.weeks, { ...base.weeks[0] }] };
    expect(Scheme.safeParse(duplicate).success).toBe(false);
    const badKind = { ...base, weeks: [{ ...base.weeks[0], kind: 'holiday' }] };
    expect(Scheme.safeParse(badKind).success).toBe(false);
  });

  it('requires a valid level and term', () => {
    const base = teachingScheme(3);
    expect(Scheme.safeParse({ ...base, level_code: 'P7' }).success).toBe(false);
    expect(Scheme.safeParse({ ...base, term: 4 }).success).toBe(false);
  });
});
