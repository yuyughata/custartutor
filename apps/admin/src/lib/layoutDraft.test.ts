import { describe, expect, it } from 'vitest';
import type { ChapterRow, UnitRow } from '../api/types';
import {
  addChapter,
  addUnit,
  blankFields,
  canAddUnit,
  canEditDetails,
  canMoveToChapter,
  canMoveWithin,
  canRemoveUnit,
  draftChanged,
  draftFrom,
  draftToDoc,
  dropNewChapter,
  liveUnitCount,
  modelFrom,
  moveToChapter,
  moveWithin,
  numbering,
  removeUnit,
  setChapterTitle,
  setUnitFields,
  validateDraft,
  versionedChanges,
} from './layoutDraft';
import { planLayout } from './unitLayout';

function unit(n: number, patch: Partial<UnitRow> = {}): UnitRow {
  return {
    id: `u${n}`,
    chapter_id: n <= 4 ? 'c1' : 'c2',
    unit_no: n,
    week_no: n,
    kind: 'lesson',
    title: `Unit ${n}`,
    objective: `Objective ${n}`,
    stage: 'absorb',
    periods: 1,
    status: 'draft',
    version_count: 0,
    latest_version: null,
    latest_version_status: null,
    ...patch,
  };
}

function chapters(): ChapterRow[] {
  return [
    {
      id: 'c1',
      scheme_id: 's',
      number: 1,
      title: 'Our Environment',
      status: 'draft',
      units: [1, 2, 3, 4].map((n) =>
        unit(
          n,
          n === 2
            ? {
                status: 'published',
                version_count: 1,
                latest_version: 1,
                latest_version_status: 'published',
              }
            : {},
        ),
      ),
    },
    {
      id: 'c2',
      scheme_id: 's',
      number: 2,
      title: 'Our Homes',
      status: 'draft',
      units: [5, 6, 7, 8].map((n) =>
        unit(
          n,
          n === 6 ? { version_count: 2, latest_version: 2, latest_version_status: 'draft' } : {},
        ),
      ),
    },
  ];
}

const loaded = () => draftFrom(chapters());
const weeks = [1, 2, 3, 4, 5, 6, 7, 8];

describe('draftFrom / draftToDoc', () => {
  it('an untouched draft sends the plain current layout', () => {
    const draft = loaded();
    expect(draftChanged(draft, loaded())).toBe(false);
    const doc = draftToDoc(draft);
    expect(doc.chapters.map((c) => ('id' in c ? c.id : null))).toEqual(['c1', 'c2']);
    expect(doc.chapters[0]?.units.map((u) => ('id' in u ? u.id : null))).toEqual([
      'u1',
      'u2',
      'u3',
      'u4',
    ]);
    expect(doc.removed).toEqual([]);
    expect(planLayout(modelFrom(chapters(), weeks), doc).changes).toBe(false);
  });

  it('sends a new unit with its fields, and only the changed fields of a unit without versions', () => {
    let draft = addUnit(loaded(), 1, {
      ...blankFields('connect'),
      title: '  Caring for animals ',
      objective: 'Care',
      periods: 2,
      week_no: 4,
    });
    draft = setUnitFields(draft, 0, 0, { title: 'Renamed' });
    const doc = draftToDoc(draft);
    const added = doc.chapters[1]?.units.at(-1);
    expect(added).toEqual({
      new: {
        title: 'Caring for animals',
        objective: 'Care',
        kind: 'lesson',
        stage: 'connect',
        periods: 2,
        week_no: 4,
      },
    });
    expect(doc.chapters[0]?.units[0]).toEqual({ id: 'u1', set: { title: 'Renamed' } });
    expect(planLayout(modelFrom(chapters(), weeks), doc).counts).toMatchObject({
      units_created: 1,
      units_updated: 1,
    });
  });

  it('never sends details for a unit that has versions', () => {
    const draft = setUnitFields(loaded(), 1, 1, { title: 'Hacked' });
    expect(draft.chapters[1]?.units[1]?.fields.title).toBe('Unit 6');
    expect(canEditDetails(draft.chapters[1]!.units[1]!).ok).toBe(false);
    expect(canEditDetails(draft.chapters[1]!.units[1]!).reason).toContain('Edit by hand');
  });

  it('an unchanged unit with no edits is sent as a bare id, a removed one only in removed', () => {
    const draft = removeUnit(loaded(), 0, 2); // u3, no versions
    const doc = draftToDoc(draft);
    expect(doc.removed).toEqual(['u3']);
    expect(doc.chapters[0]?.units).toEqual([{ id: 'u1' }, { id: 'u2' }, { id: 'u4' }]);
  });
});

describe('the 3 to 5 rule in the buttons', () => {
  it('Add a unit stops at 5 and says why', () => {
    let draft = loaded();
    expect(canAddUnit(draft.chapters[0]!).ok).toBe(true);
    draft = addUnit(draft, 0, blankFields());
    expect(draft.chapters[0]?.units).toHaveLength(5);
    const blocked = canAddUnit(draft.chapters[0]!);
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toContain('at most 5');
    expect(addUnit(draft, 0, blankFields())).toBe(draft);
  });

  it('Remove stops at 3 and refuses a unit that has versions', () => {
    const draft = loaded();
    expect(canRemoveUnit(draft, 0, 2).ok).toBe(true);
    const published = canRemoveUnit(draft, 0, 1);
    expect(published.ok).toBe(false);
    expect(published.reason).toContain('1 version');
    expect(canRemoveUnit(draft, 1, 1).reason).toContain('2 versions');
    const smaller = removeUnit(draft, 0, 2);
    expect(smaller.chapters[0]?.units).toHaveLength(3);
    expect(canRemoveUnit(smaller, 0, 0).reason).toContain('at least 3');
    expect(removeUnit(smaller, 0, 0)).toBe(smaller);
    expect(removeUnit(draft, 0, 1)).toBe(draft);
  });

  it('a unit added in the draft just disappears when removed again (nothing to archive)', () => {
    const grown = addUnit(loaded(), 0, blankFields());
    const back = removeUnit(grown, 0, 4);
    expect(back.removed).toEqual([]);
    expect(draftChanged(back, loaded())).toBe(false);
  });
});

describe('moving', () => {
  it('reorders inside a chapter and numbers follow the position', () => {
    const draft = moveWithin(loaded(), 0, 2, -1);
    expect(draft.chapters[0]?.units.map((u) => u.id)).toEqual(['u1', 'u3', 'u2', 'u4']);
    expect(canMoveWithin(draft, 0, 0, -1).ok).toBe(false);
    expect(canMoveWithin(draft, 0, 3, 1).reason).toContain('last');
    const numbers = numbering(draft);
    expect(numbers.get(draft.chapters[0]!.units[1]!.key)).toBe(2);
    expect(moveWithin(draft, 0, 0, -1)).toBe(draft);
  });

  it('moves a boundary unit to the neighbouring chapter, within 3 to 5', () => {
    const grown = addUnit(loaded(), 0, blankFields()); // chapter 1 has 5
    expect(canMoveToChapter(grown, 0, 4, 'next').ok).toBe(true);
    const moved = moveToChapter(grown, 0, 4, 'next');
    expect(moved.chapters[0]?.units).toHaveLength(4);
    expect(moved.chapters[1]?.units).toHaveLength(5);
    expect(moved.chapters[1]?.units[0]?.id).toBeNull();
    // chapter 2 is now full, chapter 1 cannot take one back more than 5 ... and the middle is not a boundary
    expect(canMoveToChapter(moved, 1, 0, 'previous').ok).toBe(true);
    expect(canMoveToChapter(moved, 0, 1, 'next').reason).toContain('Only the last unit');
    expect(canMoveToChapter(loaded(), 0, 0, 'previous').reason).toContain('first chapter');
    expect(canMoveToChapter(loaded(), 1, 3, 'next').reason).toContain('last chapter');
  });

  it('refuses to push a chapter over 5 or under 3, and keeps a published unit in its chapter', () => {
    const full = addUnit(loaded(), 1, blankFields()); // chapter 2 has 5
    expect(canMoveToChapter(full, 0, 3, 'next').reason).toContain('already has 5');
    expect(canMoveToChapter(loaded(), 0, 3, 'next').ok).toBe(true);
    const small = removeUnit(loaded(), 1, 3); // chapter 2 has 3
    expect(canMoveToChapter(small, 1, 0, 'previous').reason).toContain('fewer than 3');
    // u2 is published; make it the last of chapter 1 and it still may not leave
    const reordered = moveWithin(moveWithin(loaded(), 0, 1, 1), 0, 2, 1);
    expect(reordered.chapters[0]?.units[3]?.id).toBe('u2');
    expect(canMoveToChapter(reordered, 0, 3, 'next').reason).toContain('published');
  });
});

describe('chapters', () => {
  it('adds a chapter with three blank units and a title to fill in', () => {
    const draft = addChapter(loaded());
    expect(draft.chapters).toHaveLength(3);
    const added = draft.chapters[2]!;
    expect(added).toMatchObject({ id: null, number: 3, title: '' });
    expect(added.units).toHaveLength(3);
    const issues = validateDraft(draft).filter((i) => i.chapter === 2);
    expect(issues.some((i) => i.message.includes('needs a title'))).toBe(true);
    expect(issues.filter((i) => i.unit !== undefined).length).toBeGreaterThanOrEqual(6);
    expect(setChapterTitle(draft, 2, 'Our Community').chapters[2]?.title).toBe('Our Community');
    expect(setChapterTitle(draft, 0, 'Renamed').chapters[0]?.title).toBe('Our Environment');
    expect(dropNewChapter(draft, 2).chapters).toHaveLength(2);
    expect(dropNewChapter(draft, 0)).toBe(draft);
  });

  it('a filled-in new chapter becomes a layout the rules accept', () => {
    let draft = setChapterTitle(addChapter(loaded()), 2, 'Our Community');
    for (let ui = 0; ui < 3; ui += 1) {
      draft = setUnitFields(draft, 2, ui, { title: `T${ui}`, objective: `O${ui}` });
    }
    expect(validateDraft(draft)).toEqual([]);
    const plan = planLayout(modelFrom(chapters(), weeks), draftToDoc(draft));
    expect(plan.counts.chapters_created).toBe(1);
    expect(plan.counts.units_created).toBe(3);
    expect(liveUnitCount(draft)).toBe(11);
  });
});

describe('what a change does to units with versions', () => {
  it('lists the units with versions whose number or chapter would change', () => {
    expect(versionedChanges(loaded())).toEqual([]);
    const early = addUnit(loaded(), 0, blankFields()); // unit 6 (2 versions) becomes 7
    expect(versionedChanges(early)).toEqual([
      { title: 'Unit 6', from: 6, to: 7, chapter: 2, moved: false },
    ]);
    // adding to the LAST chapter changes no number
    expect(versionedChanges(addUnit(loaded(), 1, blankFields()))).toEqual([]);
    // moving the draft-versioned unit to chapter 1 changes chapter
    const first = moveWithin(moveWithin(loaded(), 1, 1, -1), 1, 0, -1);
    const moved = moveToChapter(addUnit(first, 1, blankFields()), 1, 0, 'previous');
    expect(versionedChanges(moved).some((c) => c.title === 'Unit 6' && c.moved)).toBe(true);
  });

  it('agrees with the rules: whatever it lists, the server wants confirmed', () => {
    const early = addUnit(loaded(), 0, { ...blankFields(), title: 'T', objective: 'O' });
    const model = modelFrom(chapters(), weeks);
    expect(() => planLayout(model, draftToDoc(early))).toThrow();
    expect(planLayout(model, draftToDoc(early), { confirmRenumber: true }).versioned).toHaveLength(
      1,
    );
  });
});

describe('validateDraft', () => {
  it('flags blank titles, objectives and bad periods on units, and the count of a chapter', () => {
    let draft = addUnit(loaded(), 0, blankFields());
    const issues = validateDraft(draft).map((i) => i.message);
    expect(issues.some((m) => m.includes('needs a title'))).toBe(true);
    expect(issues.some((m) => m.includes('needs an objective'))).toBe(true);
    draft = setUnitFields(draft, 0, 4, { title: 'T', objective: 'O', periods: 11 });
    expect(validateDraft(draft).some((i) => i.message.includes('Periods'))).toBe(true);
    expect(validateDraft(loaded())).toEqual([]);
  });
});
