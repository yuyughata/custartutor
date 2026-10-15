// The planner's editable layout: chapters with units, edited in the browser until "Apply layout" sends one atomic
// call. Pure updaters (no React): add a unit, remove a unit that has no version, reorder inside a chapter, move a
// boundary unit to the neighbouring chapter, edit the details of a unit that has no version, add a chapter. The
// 3 to 5 rule is checked here for the buttons and the messages; the server (`apply_unit_layout`) and
// `publish_unit_version` enforce it again.
import type { Stage, UnitKind } from '@custar/content-schema';
import type { ChapterRow } from '../api/types';
import {
  CHAPTER_MAX_UNITS,
  CHAPTER_MIN_UNITS,
  type LayoutChapterEntry,
  type LayoutDoc,
  type LayoutEntry,
  type LayoutModel,
  type UnitFields,
} from './unitLayout';

export interface DraftUnit {
  /** Stable React key. */
  key: string;
  /** The unit's id; null for a unit added in this draft. */
  id: string | null;
  fields: UnitFields;
  lens?: string;
  hasVersions: boolean;
  published: boolean;
  /** Version numbers and the number it has now, for the list. */
  versionCount: number;
  currentNo: number | null;
  /** The fields as loaded, to send only what changed. */
  original: UnitFields | null;
  /** The chapter it was loaded in. */
  chapterId: string | null;
}

export interface DraftChapter {
  key: string;
  id: string | null;
  number: number;
  title: string;
  units: DraftUnit[];
}

export interface LayoutDraft {
  chapters: DraftChapter[];
  /** Existing units taken out of the layout (they will be archived). */
  removed: DraftUnit[];
  nextKey: number;
}

export function draftFrom(chapters: readonly ChapterRow[]): LayoutDraft {
  let key = 0;
  return {
    chapters: chapters.map((chapter) => ({
      key: `c${(key += 1)}`,
      id: chapter.id,
      number: chapter.number,
      title: chapter.title,
      units: chapter.units.map((unit) => {
        const fields: UnitFields = {
          title: unit.title,
          objective: unit.objective ?? '',
          kind: unit.kind,
          stage: unit.stage,
          periods: unit.periods,
          week_no: unit.week_no,
        };
        return {
          key: `u${(key += 1)}`,
          id: unit.id,
          fields,
          hasVersions: unit.version_count > 0,
          published: unit.status === 'published',
          versionCount: unit.version_count,
          currentNo: unit.unit_no,
          original: { ...fields },
          chapterId: chapter.id,
        };
      }),
    })),
    removed: [],
    nextKey: key + 1,
  };
}

export function modelFrom(chapters: readonly ChapterRow[], weeks: readonly number[]): LayoutModel {
  return {
    chapters: chapters.map((c) => ({ id: c.id, number: c.number, title: c.title })),
    units: chapters.flatMap((c) =>
      c.units.map((u) => ({
        id: u.id,
        chapter_id: c.id,
        unit_no: u.unit_no,
        title: u.title,
        objective: u.objective ?? '',
        kind: u.kind,
        stage: u.stage,
        periods: u.periods,
        week_no: u.week_no,
        hasVersions: u.version_count > 0,
        published: u.status === 'published',
      })),
    ),
    weeks: [...weeks],
  };
}

function sameFields(a: UnitFields, b: UnitFields): boolean {
  return (
    a.title === b.title &&
    a.objective === b.objective &&
    a.kind === b.kind &&
    a.stage === b.stage &&
    a.periods === b.periods &&
    a.week_no === b.week_no
  );
}

/** What `apply_unit_layout` takes. Only the fields a person changed are sent, and only for units without versions. */
export function draftToDoc(draft: LayoutDraft): LayoutDoc {
  const chapters: LayoutChapterEntry[] = draft.chapters.map((chapter) => {
    const units: LayoutEntry[] = chapter.units.map((unit) => {
      if (unit.id === null) {
        const fields = unit.fields;
        return {
          new: {
            title: fields.title.trim(),
            objective: fields.objective.trim(),
            kind: fields.kind,
            stage: fields.stage,
            periods: fields.periods,
            ...(fields.week_no !== null ? { week_no: fields.week_no } : {}),
            ...(unit.lens ? { lens: unit.lens } : {}),
          },
        };
      }
      if (!unit.hasVersions && unit.original && !sameFields(unit.fields, unit.original)) {
        const set: Partial<UnitFields> = {};
        const f = unit.fields;
        const o = unit.original;
        if (f.title !== o.title) set.title = f.title.trim();
        if (f.objective !== o.objective) set.objective = f.objective.trim();
        if (f.kind !== o.kind) set.kind = f.kind;
        if (f.stage !== o.stage) set.stage = f.stage;
        if (f.periods !== o.periods) set.periods = f.periods;
        if (f.week_no !== o.week_no) set.week_no = f.week_no;
        return { id: unit.id, set };
      }
      return { id: unit.id };
    });
    return chapter.id === null
      ? { new: { title: chapter.title.trim() }, units }
      : { id: chapter.id, units };
  });
  return { chapters, removed: draft.removed.flatMap((u) => (u.id ? [u.id] : [])) };
}

/** True when the draft differs from the loaded layout. */
export function draftChanged(draft: LayoutDraft, loaded: LayoutDraft): boolean {
  return JSON.stringify(shape(draft)) !== JSON.stringify(shape(loaded));
}

function shape(draft: LayoutDraft): unknown {
  return {
    c: draft.chapters.map((c) => [c.id, c.title, c.units.map((u) => [u.id, u.fields])]),
    r: draft.removed.map((u) => u.id),
  };
}

// --- numbering ---------------------------------------------------------------------------------------------------------

/** The number each unit would have: its rank in the term. Keyed by unit key. */
export function numbering(draft: LayoutDraft): Map<string, number> {
  const out = new Map<string, number>();
  let rank = 0;
  for (const chapter of draft.chapters) {
    for (const unit of chapter.units) {
      rank += 1;
      out.set(unit.key, rank);
    }
  }
  return out;
}

export function liveUnitCount(draft: LayoutDraft): number {
  return draft.chapters.reduce((sum, c) => sum + c.units.length, 0);
}

// --- rules for the buttons ----------------------------------------------------------------------------------------------

export interface Allowed {
  ok: boolean;
  reason: string | null;
}

export function canAddUnit(chapter: DraftChapter): Allowed {
  return chapter.units.length >= CHAPTER_MAX_UNITS
    ? { ok: false, reason: `A chapter holds at most ${CHAPTER_MAX_UNITS} units.` }
    : { ok: true, reason: null };
}

export function canRemoveUnit(
  draft: LayoutDraft,
  chapterIndex: number,
  unitIndex: number,
): Allowed {
  const chapter = draft.chapters[chapterIndex];
  const unit = chapter?.units[unitIndex];
  if (!chapter || !unit) return { ok: false, reason: 'No such unit.' };
  if (unit.hasVersions) {
    return {
      ok: false,
      reason: `This unit has ${unit.versionCount} version${unit.versionCount === 1 ? '' : 's'}, so it cannot be removed. Nothing is deleted from a unit that has drafts.`,
    };
  }
  if (chapter.units.length <= CHAPTER_MIN_UNITS) {
    return {
      ok: false,
      reason: `A chapter needs at least ${CHAPTER_MIN_UNITS} units. Add another unit first.`,
    };
  }
  return { ok: true, reason: null };
}

export function canMoveWithin(
  draft: LayoutDraft,
  chapterIndex: number,
  unitIndex: number,
  delta: -1 | 1,
): Allowed {
  const chapter = draft.chapters[chapterIndex];
  if (!chapter?.units[unitIndex]) return { ok: false, reason: 'No such unit.' };
  const target = unitIndex + delta;
  if (target < 0) return { ok: false, reason: 'It is already first in its chapter.' };
  if (target >= chapter.units.length)
    return { ok: false, reason: 'It is already last in its chapter.' };
  return { ok: true, reason: null };
}

/** A unit moves to the neighbouring chapter from the edge it is on (first to the previous, last to the next). */
export function canMoveToChapter(
  draft: LayoutDraft,
  chapterIndex: number,
  unitIndex: number,
  direction: 'previous' | 'next',
): Allowed {
  const chapter = draft.chapters[chapterIndex];
  const unit = chapter?.units[unitIndex];
  const targetIndex = direction === 'previous' ? chapterIndex - 1 : chapterIndex + 1;
  const target = draft.chapters[targetIndex];
  if (!chapter || !unit) return { ok: false, reason: 'No such unit.' };
  if (!target) {
    return {
      ok: false,
      reason: direction === 'previous' ? 'This is the first chapter.' : 'This is the last chapter.',
    };
  }
  const edge = direction === 'previous' ? unitIndex === 0 : unitIndex === chapter.units.length - 1;
  if (!edge) {
    return {
      ok: false,
      reason: `Only the ${direction === 'previous' ? 'first' : 'last'} unit of a chapter can move ${direction === 'previous' ? 'back' : 'forward'}. Move it to that place first.`,
    };
  }
  if (unit.published && unit.id !== null) {
    return { ok: false, reason: 'A published unit stays in its chapter.' };
  }
  if (target.units.length >= CHAPTER_MAX_UNITS) {
    return {
      ok: false,
      reason: `Chapter ${target.number} already has ${CHAPTER_MAX_UNITS} units.`,
    };
  }
  if (chapter.units.length <= CHAPTER_MIN_UNITS) {
    return {
      ok: false,
      reason: `Chapter ${chapter.number} would have fewer than ${CHAPTER_MIN_UNITS} units.`,
    };
  }
  return { ok: true, reason: null };
}

export function canEditDetails(unit: DraftUnit): Allowed {
  return unit.hasVersions
    ? {
        ok: false,
        reason:
          'This unit has drafts. Change its title or objective in a new version (Edit by hand) instead.',
      }
    : { ok: true, reason: null };
}

// --- updaters -----------------------------------------------------------------------------------------------------------

function mapChapter(
  draft: LayoutDraft,
  index: number,
  fn: (chapter: DraftChapter) => DraftChapter,
): LayoutDraft {
  return { ...draft, chapters: draft.chapters.map((c, i) => (i === index ? fn(c) : c)) };
}

export function blankFields(stage: Stage = 'absorb', kind: UnitKind = 'lesson'): UnitFields {
  return { title: '', objective: '', kind, stage, periods: 1, week_no: null };
}

export function addUnit(
  draft: LayoutDraft,
  chapterIndex: number,
  fields: UnitFields,
  lens?: string,
): LayoutDraft {
  const chapter = draft.chapters[chapterIndex];
  if (!chapter || !canAddUnit(chapter).ok) return draft;
  const unit: DraftUnit = {
    key: `u${draft.nextKey}`,
    id: null,
    fields,
    ...(lens ? { lens } : {}),
    hasVersions: false,
    published: false,
    versionCount: 0,
    currentNo: null,
    original: null,
    chapterId: null,
  };
  return {
    ...mapChapter(draft, chapterIndex, (c) => ({ ...c, units: [...c.units, unit] })),
    nextKey: draft.nextKey + 1,
  };
}

export function removeUnit(
  draft: LayoutDraft,
  chapterIndex: number,
  unitIndex: number,
): LayoutDraft {
  if (!canRemoveUnit(draft, chapterIndex, unitIndex).ok) return draft;
  const unit = draft.chapters[chapterIndex]?.units[unitIndex];
  if (!unit) return draft;
  const next = mapChapter(draft, chapterIndex, (c) => ({
    ...c,
    units: c.units.filter((_, i) => i !== unitIndex),
  }));
  // A unit added in this draft just disappears; an existing one is archived by the server.
  return unit.id === null ? next : { ...next, removed: [...next.removed, unit] };
}

export function moveWithin(
  draft: LayoutDraft,
  chapterIndex: number,
  unitIndex: number,
  delta: -1 | 1,
): LayoutDraft {
  if (!canMoveWithin(draft, chapterIndex, unitIndex, delta).ok) return draft;
  return mapChapter(draft, chapterIndex, (c) => {
    const units = c.units.slice();
    const [moved] = units.splice(unitIndex, 1);
    if (moved) units.splice(unitIndex + delta, 0, moved);
    return { ...c, units };
  });
}

export function moveToChapter(
  draft: LayoutDraft,
  chapterIndex: number,
  unitIndex: number,
  direction: 'previous' | 'next',
): LayoutDraft {
  if (!canMoveToChapter(draft, chapterIndex, unitIndex, direction).ok) return draft;
  const unit = draft.chapters[chapterIndex]?.units[unitIndex];
  if (!unit) return draft;
  const targetIndex = direction === 'previous' ? chapterIndex - 1 : chapterIndex + 1;
  return {
    ...draft,
    chapters: draft.chapters.map((c, i) => {
      if (i === chapterIndex) return { ...c, units: c.units.filter((_, at) => at !== unitIndex) };
      if (i === targetIndex) {
        return { ...c, units: direction === 'previous' ? [...c.units, unit] : [unit, ...c.units] };
      }
      return c;
    }),
  };
}

export function setUnitFields(
  draft: LayoutDraft,
  chapterIndex: number,
  unitIndex: number,
  patch: Partial<UnitFields>,
): LayoutDraft {
  const unit = draft.chapters[chapterIndex]?.units[unitIndex];
  if (!unit || !canEditDetails(unit).ok) return draft;
  return mapChapter(draft, chapterIndex, (c) => ({
    ...c,
    units: c.units.map((u, i) =>
      i === unitIndex ? { ...u, fields: { ...u.fields, ...patch } } : u,
    ),
  }));
}

export function setChapterTitle(
  draft: LayoutDraft,
  chapterIndex: number,
  title: string,
): LayoutDraft {
  const chapter = draft.chapters[chapterIndex];
  // Only a chapter added in this draft is renamed here; existing chapters are renamed by re-planning.
  if (!chapter || chapter.id !== null) return draft;
  return mapChapter(draft, chapterIndex, (c) => ({ ...c, title }));
}

/** A new chapter at the end, with three blank units to fill in (a chapter needs at least three). */
export function addChapter(draft: LayoutDraft, title = ''): LayoutDraft {
  const last = draft.chapters[draft.chapters.length - 1];
  const number = (last?.number ?? 0) + 1;
  let key = draft.nextKey;
  const units: DraftUnit[] = Array.from({ length: CHAPTER_MIN_UNITS }, () => ({
    key: `u${(key += 1)}`,
    id: null,
    fields: blankFields(),
    hasVersions: false,
    published: false,
    versionCount: 0,
    currentNo: null,
    original: null,
    chapterId: null,
  }));
  const chapter: DraftChapter = { key: `c${(key += 1)}`, id: null, number, title, units };
  return { ...draft, chapters: [...draft.chapters, chapter], nextKey: key + 1 };
}

/** Removes a chapter that was added in this draft (an existing chapter cannot be removed). */
export function dropNewChapter(draft: LayoutDraft, chapterIndex: number): LayoutDraft {
  const chapter = draft.chapters[chapterIndex];
  if (!chapter || chapter.id !== null) return draft;
  return { ...draft, chapters: draft.chapters.filter((_, i) => i !== chapterIndex) };
}

// --- checks -------------------------------------------------------------------------------------------------------------

export interface DraftIssue {
  chapter: number;
  unit?: number;
  message: string;
}

export function validateDraft(draft: LayoutDraft): DraftIssue[] {
  const issues: DraftIssue[] = [];
  draft.chapters.forEach((chapter, ci) => {
    const count = chapter.units.length;
    if (count < CHAPTER_MIN_UNITS || count > CHAPTER_MAX_UNITS) {
      issues.push({
        chapter: ci,
        message: `Chapter ${chapter.number} has ${count} unit${count === 1 ? '' : 's'}; it needs ${CHAPTER_MIN_UNITS} to ${CHAPTER_MAX_UNITS}.`,
      });
    }
    if (chapter.id === null && chapter.title.trim() === '') {
      issues.push({ chapter: ci, message: `Chapter ${chapter.number} needs a title.` });
    }
    chapter.units.forEach((unit, ui) => {
      if (unit.fields.title.trim() === '') {
        issues.push({ chapter: ci, unit: ui, message: 'This unit needs a title.' });
      }
      if (unit.fields.objective.trim() === '') {
        issues.push({
          chapter: ci,
          unit: ui,
          message: 'This unit needs an objective (what the child will learn).',
        });
      }
      if (
        !Number.isInteger(unit.fields.periods) ||
        unit.fields.periods < 1 ||
        unit.fields.periods > 10
      ) {
        issues.push({
          chapter: ci,
          unit: ui,
          message: 'Periods must be a whole number from 1 to 10.',
        });
      }
    });
  });
  return issues;
}

/** The units with versions whose number or chapter this draft changes (for the confirmation before applying). */
export function versionedChanges(
  draft: LayoutDraft,
): { title: string; from: number; to: number; chapter: number; moved: boolean }[] {
  const out: { title: string; from: number; to: number; chapter: number; moved: boolean }[] = [];
  const numbers = numbering(draft);
  draft.chapters.forEach((chapter) => {
    chapter.units.forEach((unit) => {
      const to = numbers.get(unit.key);
      if (unit.id === null || !unit.hasVersions || unit.currentNo === null || to === undefined)
        return;
      const moved = unit.chapterId !== chapter.id;
      if (to !== unit.currentNo || moved) {
        out.push({
          title: unit.fields.title,
          from: unit.currentNo,
          to,
          chapter: chapter.number,
          moved,
        });
      }
    });
  });
  return out;
}
