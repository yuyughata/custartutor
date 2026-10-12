import { describe, expect, it } from 'vitest';
import type { ChapterPlan, PlannedUnit } from '@custar/authoring-core';
import { p1BasicScienceTerm1 } from '@custar/content-schema/fixtures';
import {
  canMoveUnit,
  hasPlanErrors,
  issuesForChapter,
  moveUnit,
  normalizePlan,
  plansEqual,
  renameChapter,
  setTheme,
  slugify,
  unitCount,
  updateUnit,
  validatePlan,
} from './planEdit';

function unit(no: number, week = no): PlannedUnit {
  return {
    unit_no: no,
    week_no: week,
    kind: 'lesson',
    title: `Unit ${no}`,
    objective: `Objective ${no}`,
    stage: 'absorb',
    periods: 1,
  };
}

function chapter(no: number, unitNos: number[]) {
  return { chapter_no: no, title: `Chapter ${no}`, units: unitNos.map((n) => unit(n)) };
}

/** 4 + 4: the plan groupIntoChapters gives for the 8 teaching weeks of Term 1. */
const plan = (): ChapterPlan => ({ chapters: [chapter(1, [1, 2, 3, 4]), chapter(2, [5, 6, 7, 8])] });

describe('moving units between chapters', () => {
  it('moves the last unit of a chapter to the start of the next', () => {
    const wide: ChapterPlan = { chapters: [chapter(1, [1, 2, 3, 4, 5]), chapter(2, [6, 7, 8])] };
    expect(canMoveUnit(wide, 0, 4, 'next')).toEqual({ ok: true });
    const moved = moveUnit(wide, 0, 4, 'next');
    expect(moved.chapters[0]?.units.map((u) => u.unit_no)).toEqual([1, 2, 3, 4]);
    expect(moved.chapters[1]?.units.map((u) => u.unit_no)).toEqual([5, 6, 7, 8]);
    expect(unitCount(moved)).toBe(unitCount(wide));
  });

  it('moves the first unit of a chapter to the end of the previous', () => {
    const wide: ChapterPlan = { chapters: [chapter(1, [1, 2, 3]), chapter(2, [4, 5, 6, 7, 8])] };
    const moved = moveUnit(wide, 1, 0, 'previous');
    expect(moved.chapters[0]?.units.map((u) => u.unit_no)).toEqual([1, 2, 3, 4]);
    expect(moved.chapters[1]?.units.map((u) => u.unit_no)).toEqual([5, 6, 7, 8]);
  });

  it('refuses a move that would leave a chapter with fewer than 3 units', () => {
    const result = canMoveUnit(plan(), 0, 3, 'next');
    expect(result.ok).toBe(true); // 4 -> 3 and 4 -> 5 is fine
    const tight: ChapterPlan = { chapters: [chapter(1, [1, 2, 3]), chapter(2, [4, 5, 6, 7])] };
    const refused = canMoveUnit(tight, 0, 2, 'next');
    expect(refused.ok).toBe(false);
    expect(refused.reason).toMatch(/chapter 1 would have 2 units/);
    expect(moveUnit(tight, 0, 2, 'next')).toBe(tight);
  });

  it('refuses a move that would give the target more than 5 units', () => {
    const full: ChapterPlan = { chapters: [chapter(1, [1, 2, 3, 4]), chapter(2, [5, 6, 7, 8, 9])] };
    const refused = canMoveUnit(full, 0, 3, 'next');
    expect(refused.ok).toBe(false);
    expect(refused.reason).toMatch(/chapter 2 would have 6 units/);
  });

  it('allows a move that repairs an invalid plan', () => {
    const broken: ChapterPlan = { chapters: [chapter(1, [1, 2]), chapter(2, [3, 4, 5, 6, 7])] };
    expect(canMoveUnit(broken, 1, 0, 'previous')).toEqual({ ok: true });
    const fixed = moveUnit(broken, 1, 0, 'previous');
    expect(hasPlanErrors(validatePlan(fixed))).toBe(false);
  });

  it('only moves boundary units, so the unit order never changes', () => {
    const wide: ChapterPlan = { chapters: [chapter(1, [1, 2, 3, 4, 5]), chapter(2, [6, 7, 8])] };
    const middle = canMoveUnit(wide, 0, 2, 'next');
    expect(middle.ok).toBe(false);
    expect(middle.reason).toMatch(/Only the last unit/);
    const first = canMoveUnit(wide, 1, 1, 'previous');
    expect(first.ok).toBe(false);
  });

  it('has no neighbour beyond the first and last chapter', () => {
    expect(canMoveUnit(plan(), 0, 0, 'previous')).toMatchObject({ ok: false, reason: 'This is the first chapter.' });
    expect(canMoveUnit(plan(), 1, 3, 'next')).toMatchObject({ ok: false, reason: 'This is the last chapter.' });
  });
});

describe('editing', () => {
  it('renames a chapter and edits a unit without touching the original', () => {
    const original = plan();
    const renamed = renameChapter(original, 1, 'Shapes and living things');
    expect(renamed.chapters[1]?.title).toBe('Shapes and living things');
    expect(original.chapters[1]?.title).toBe('Chapter 2');
    const edited = updateUnit(renamed, 0, 1, { title: 'New title', objective: 'New objective', stage: 'connect' });
    expect(edited.chapters[0]?.units[1]).toMatchObject({ title: 'New title', stage: 'connect' });
  });

  it('drops stage_to when it equals the stage', () => {
    const edited = updateUnit(plan(), 0, 0, { stage: 'connect', stage_to: 'connect' });
    expect(edited.chapters[0]?.units[0]).not.toHaveProperty('stage_to');
  });

  it('adds and removes a theme', () => {
    const withTheme = setTheme(plan(), 0, { title: 'Market Day', lens: 'Value' });
    expect(withTheme.chapters[0]?.theme).toEqual({ slug: 'market-day', title: 'Market Day', lens: 'Value' });
    const without = setTheme(withTheme, 0, null);
    expect(without.chapters[0]).not.toHaveProperty('theme');
  });

  it('makes valid slugs', () => {
    expect(slugify('Market Day!')).toBe('market-day');
    expect(slugify('Ọmọ ilé')).toBe('omo-ile');
    expect(slugify('3 little pigs')).toBe('t-3-little-pigs');
    expect(slugify('???')).toBe('theme');
  });

  it('compares plans ignoring whitespace', () => {
    expect(plansEqual(plan(), renameChapter(plan(), 0, 'Chapter 1  '))).toBe(true);
    expect(plansEqual(plan(), renameChapter(plan(), 0, 'Other'))).toBe(false);
  });

  it('normalises: trims and renumbers chapters', () => {
    const odd = { chapters: [{ ...chapter(7, [1, 2, 3]), title: '  Spaced  ' }] };
    expect(normalizePlan(odd).chapters[0]).toMatchObject({ chapter_no: 1, title: 'Spaced' });
  });
});

describe('validatePlan', () => {
  it('accepts the 4 + 4 plan against the Term 1 scheme', () => {
    const weeks = p1BasicScienceTerm1.weeks.filter((w) => w.kind === 'teaching').map((w) => w.week_no);
    const real: ChapterPlan = {
      chapters: [chapter(1, [1, 2, 3, 4]), chapter(2, [5, 6, 7, 8])].map((c) => ({
        ...c,
        units: c.units.map((u) => ({ ...u, week_no: weeks[u.unit_no - 1] as number })),
      })),
    };
    expect(validatePlan(real, p1BasicScienceTerm1)).toEqual([]);
  });

  it('reports a chapter with the wrong number of units, live', () => {
    const issues = validatePlan({ chapters: [chapter(1, [1, 2]), chapter(2, [3, 4, 5, 6, 7, 8])] });
    const messages = issues.map((i) => i.message);
    expect(messages).toContain('Chapter 1 has 2 units; it needs 3 to 5.');
    expect(messages).toContain('Chapter 2 has 6 units; it needs 3 to 5.');
    expect(hasPlanErrors(issues)).toBe(true);
    expect(issuesForChapter(issues, 0)).toHaveLength(1);
  });

  it('reports blank titles and objectives on the unit they belong to', () => {
    const edited = updateUnit(plan(), 1, 2, { title: ' ', objective: '' });
    const issues = validatePlan(edited);
    expect(issuesForChapter(issues, 1, 2).map((i) => i.message)).toEqual([
      'Chapter 2, unit 7 needs a title.',
      'Chapter 2, unit 7 needs an objective (the NERDC objective for the week).',
    ]);
  });

  it('reports a backwards stage range and unit numbers out of order', () => {
    let edited = updateUnit(plan(), 0, 0, { stage: 'express', stage_to: 'absorb' });
    edited = updateUnit(edited, 1, 0, { unit_no: 2 });
    const messages = validatePlan(edited).map((i) => i.message);
    expect(messages.some((m) => /end stage cannot be earlier/.test(m))).toBe(true);
    expect(messages.some((m) => /out of order/.test(m))).toBe(true);
  });

  it('warns about teaching weeks without a unit and units on non-teaching weeks', () => {
    const lone: ChapterPlan = { chapters: [chapter(1, [1, 2, 3])] };
    const issues = validatePlan(lone, p1BasicScienceTerm1);
    const warnings = issues.filter((i) => i.severity === 'warning').map((i) => i.message);
    expect(warnings.some((m) => /Teaching week 7 .* has no unit/.test(m))).toBe(true);
    expect(hasPlanErrors(issues)).toBe(false);
  });

  it('rejects an empty plan', () => {
    expect(validatePlan({ chapters: [] })[0]?.message).toBe('The plan has no chapters.');
  });
});
