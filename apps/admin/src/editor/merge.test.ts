import { describe, expect, it } from 'vitest';
import { goldenUnit2 } from '@custar/content-schema/fixtures';
import { parseUnit } from '@custar/content-schema';
import { ORDER_KEY, changesBetween, itemsOf, mergeUnits } from './merge';
import { addQuestion, addSection, moveSection, removeSection, sections } from './ops';
import { getAt, setAt } from './path';

const base = structuredClone(goldenUnit2) as never;
const none = new Set<string>();

function section(unit: unknown, index: number): string {
  return String((sections(unit as never)[index] as { id: string }).id);
}
const edit = (unit: unknown, index: number, text: string) =>
  setAt(unit as never, ['sections', index, 'heading'], text);

describe('itemsOf', () => {
  it('splits a unit into the header, each section, each question, the order and the other parts', () => {
    const items = itemsOf(base);
    expect(items.has('header')).toBe(true);
    expect(items.has(ORDER_KEY)).toBe(true);
    expect(items.has(`section:${section(base, 0)}`)).toBe(true);
    expect([...items.keys()].some((k) => k.startsWith('question:'))).toBe(true);
    expect(items.has('top:workbook')).toBe(true);
    expect(items.has('top:session_plan')).toBe(true);
  });

  it('leaves the planner-owned header fields out, so they never clash', () => {
    const header = itemsOf(base).get('header') as Record<string, unknown>;
    expect(header).not.toHaveProperty('unit_no');
    expect(header).not.toHaveProperty('chapter');
    expect(header).not.toHaveProperty('week_no');
  });
});

describe('changesBetween', () => {
  it('lists what changed, named in words', () => {
    const changed = edit(base, 1, 'A new heading');
    const out = changesBetween(base, changed);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ key: `section:${section(base, 1)}`, change: 'changed' });
    expect(out[0]?.label).toContain(section(base, 1));
  });

  it('sees added and removed sections and a reorder', () => {
    const grown = addSection(base, 'concept', none).unit;
    expect(changesBetween(base, grown).map((c) => c.change)).toEqual(
      expect.arrayContaining(['added']),
    );
    const shrunk = removeSection(base, 3).unit;
    expect(changesBetween(base, shrunk).some((c) => c.change === 'removed')).toBe(true);
    const moved = moveSection(base, 0, 2);
    expect(changesBetween(base, moved).some((c) => c.key === ORDER_KEY)).toBe(true);
  });

  it('is empty for equal units', () => {
    expect(changesBetween(base, structuredClone(base))).toEqual([]);
  });
});

describe('mergeUnits', () => {
  it('takes both sides when they edited different sections', () => {
    const mine = edit(base, 1, 'Mine');
    const theirs = edit(base, 2, 'Theirs');
    const result = mergeUnits(base, mine, theirs);
    expect(result.clashes).toEqual([]);
    expect(getAt(result.merged, ['sections', 1, 'heading'])).toBe('Mine');
    expect(getAt(result.merged, ['sections', 2, 'heading'])).toBe('Theirs');
    expect(() => parseUnit(result.merged)).not.toThrow();
  });

  it('is not a clash when both made the same change', () => {
    const result = mergeUnits(base, edit(base, 1, 'Same'), edit(base, 1, 'Same'));
    expect(result.clashes).toEqual([]);
    expect(getAt(result.merged, ['sections', 1, 'heading'])).toBe('Same');
  });

  it('asks which to keep when both changed the same section differently, and honours the choice', () => {
    const mine = edit(base, 1, 'Mine');
    const theirs = edit(base, 1, 'Theirs');
    const open = mergeUnits(base, mine, theirs);
    expect(open.merged).toBeNull();
    expect(open.clashes).toHaveLength(1);
    expect(open.clashes[0]).toMatchObject({ mine: 'changed', theirs: 'changed' });
    const key = open.clashes[0]!.key;
    expect(
      getAt(mergeUnits(base, mine, theirs, { [key]: 'mine' }).merged, ['sections', 1, 'heading']),
    ).toBe('Mine');
    expect(
      getAt(mergeUnits(base, mine, theirs, { [key]: 'theirs' }).merged, ['sections', 1, 'heading']),
    ).toBe('Theirs');
  });

  it('keeps both sections when each side added one', () => {
    const mine = addSection(base, 'concept', none).unit;
    const theirs = addSection(base, 'concept', none).unit;
    // the same id was generated on both sides with different content once edited
    const mineEdited = setAt(
      mine,
      ['sections', sections(mine).length - 1, 'heading'],
      'Mine added',
    );
    const theirsEdited = setAt(
      theirs,
      ['sections', sections(theirs).length - 1, 'heading'],
      'Theirs added',
    );
    const open = mergeUnits(base, mineEdited, theirsEdited);
    expect(open.clashes.map((c) => c.key)).toEqual(['section:concept_1']);
    const picked = mergeUnits(base, mineEdited, theirsEdited, { 'section:concept_1': 'mine' });
    expect(sections(picked.merged as never)).toHaveLength(sections(base).length + 1);
  });

  it('keeps my added section and their added section when the ids differ', () => {
    const mine = addSection(base, 'story_opener', none).unit;
    const theirs = addSection(base, 'concept', none).unit;
    const result = mergeUnits(base, mine, theirs);
    const ids = sections(result.merged as never).map((s) => String(s.id));
    expect(ids).toContain('story_opener_1');
    expect(ids).toContain('concept_1');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('removes a section that only I removed, and keeps one only they edited', () => {
    const removedId = section(base, 4);
    const mine = removeSection(base, 4).unit;
    const theirs = edit(base, 2, 'Theirs');
    const result = mergeUnits(base, mine, theirs);
    const ids = sections(result.merged as never).map((s) => String(s.id));
    expect(ids).not.toContain(removedId);
    expect(getAt(result.merged, ['sections', 2, 'heading'])).toBe('Theirs');
  });

  it('is a clash when I edited a section they removed', () => {
    const id = section(base, 3);
    const mine = edit(base, 3, 'Edited by me');
    const theirs = removeSection(base, 3).unit;
    const open = mergeUnits(base, mine, theirs);
    expect(open.clashes[0]).toMatchObject({
      key: `section:${id}`,
      mine: 'changed',
      theirs: 'removed',
    });
    const theirsWins = mergeUnits(base, mine, theirs, { [`section:${id}`]: 'theirs' });
    expect(sections(theirsWins.merged as never).map((s) => String(s.id))).not.toContain(id);
    const mineWins = mergeUnits(base, mine, theirs, { [`section:${id}`]: 'mine' });
    expect(sections(mineWins.merged as never).map((s) => String(s.id))).toContain(id);
  });

  it('takes my reorder when they did not reorder, and asks when both did differently', () => {
    const mine = moveSection(base, 0, 2);
    const theirs = edit(base, 5, 'Theirs');
    const mineOnly = mergeUnits(base, mine, theirs);
    expect(mineOnly.clashes).toEqual([]);
    expect(
      sections(mineOnly.merged as never)
        .map((s) => String(s.id))
        .slice(0, 3),
    ).toEqual(
      sections(mine)
        .slice(0, 3)
        .map((s) => String(s.id)),
    );
    expect(getAt(mineOnly.merged, ['sections', 5, 'heading'])).toBe('Theirs');

    const theirsMoved = moveSection(base, 1, 4);
    const both = mergeUnits(base, mine, theirsMoved);
    expect(both.clashes.map((c) => c.key)).toEqual([ORDER_KEY]);
    expect(both.merged).toBeNull();
    const resolved = mergeUnits(base, mine, theirsMoved, { [ORDER_KEY]: 'theirs' });
    expect(sections(resolved.merged as never).map((s) => String(s.id))).toEqual(
      sections(theirsMoved).map((s) => String(s.id)),
    );
  });

  it('merges questions by id', () => {
    const mine = addQuestion(base, 'mcq', none).unit;
    const theirs = setAt(
      base,
      ['questions', Object.keys((base as { questions: object }).questions)[0] as string, 'prompt'],
      'Their prompt',
    );
    const result = mergeUnits(base, mine, theirs);
    expect(result.clashes).toEqual([]);
    const questions = (result.merged as { questions: Record<string, { prompt: string }> })
      .questions;
    expect(Object.keys(questions)).toContain('q_mcq_1');
    expect(Object.values(questions).some((q) => q.prompt === 'Their prompt')).toBe(true);
  });

  it('never lets the planner-stamped header fields clash and keeps their stamp', () => {
    const mine = setAt(base, ['header', 'unit_no'], 3);
    const theirs = setAt(base, ['header', 'unit_no'], 9);
    const result = mergeUnits(base, mine, theirs);
    expect(result.clashes).toEqual([]);
    expect(getAt(result.merged, ['header', 'unit_no'])).toBe(9);
  });

  it('takes the header from me when only I changed it, keeping their stamped fields', () => {
    const mine = setAt(base, ['header', 'title'], 'My title');
    const theirs = setAt(base, ['header', 'unit_no'], 9);
    const result = mergeUnits(base, mine, theirs);
    expect(getAt(result.merged, ['header', 'title'])).toBe('My title');
    expect(getAt(result.merged, ['header', 'unit_no'])).toBe(9);
  });

  it('gives back their unit untouched when I changed nothing', () => {
    const theirs = edit(base, 2, 'Theirs');
    const result = mergeUnits(base, base, theirs);
    expect(result.merged).toEqual(theirs);
    expect(result.fromMine).toEqual([]);
  });

  it('gives back my unit when they changed nothing', () => {
    const mine = edit(base, 2, 'Mine');
    const result = mergeUnits(base, mine, base);
    expect(result.merged).toEqual(mine);
    expect(result.fromTheirs).toEqual([]);
  });
});
