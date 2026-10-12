// The rules of `apply_unit_layout` (supabase/migrations/20261012081415_m2_unit_layout.sql) as a pure function:
// given what the planner shows (chapters, units, which ones have versions or were published) and a layout, it either
// refuses with the server's stable code or says what would change. The demo backend applies the plan to its store;
// the planner uses it to show the new numbers and to know BEFORE the call whether a confirmation is needed. The SQL is
// the authority: a pgTAP scenario and a vitest scenario (unitLayout.test.ts) run the same sequence and compare the
// numbers, so the two cannot drift silently.
//
// Numbering: a unit's number is its 1-based rank in the term, in teaching order (chapter number, then position).
// A unit WITHOUT versions is renumbered, moved and edited freely. A unit WITH versions keeps its row and versions,
// is never edited here and never removed; it can change chapter or number only with `confirmRenumber`, and once it
// was published it never leaves its chapter. Removed units are archived, not deleted.
import type { Stage, UnitKind } from '@custar/content-schema';

export const CHAPTER_MIN_UNITS = 3;
export const CHAPTER_MAX_UNITS = 5;

export interface UnitFields {
  title: string;
  objective: string;
  kind: UnitKind;
  stage: Stage;
  periods: number;
  week_no: number | null;
}

export interface LayoutUnit extends UnitFields {
  id: string;
  chapter_id: string;
  unit_no: number;
  hasVersions: boolean;
  /** A snapshot of it was ever published. */
  published: boolean;
}

export interface LayoutChapter {
  id: string;
  number: number;
  title: string;
}

export interface LayoutModel {
  chapters: LayoutChapter[];
  /** Live units only (not archived). */
  units: LayoutUnit[];
  /** The weeks the scheme has, for the `week_no` check. */
  weeks: number[];
}

export type LayoutEntry =
  | { id: string; set?: Partial<UnitFields> }
  | { new: Omit<UnitFields, 'week_no' | 'periods'> & { periods?: number; week_no?: number | null; lens?: string } };

export type LayoutChapterEntry =
  | { id: string; units: LayoutEntry[] }
  | { new: { title: string }; units: LayoutEntry[] };

export interface LayoutDoc {
  chapters: LayoutChapterEntry[];
  removed?: string[];
}

export type LayoutErrorCode =
  | 'invalid_unit_layout'
  | 'invalid_layout_unit'
  | 'chapter_unit_count_invalid'
  | 'chapter_not_in_scheme'
  | 'chapter_order_changed'
  | 'duplicate_unit_in_layout'
  | 'unit_not_in_scheme'
  | 'unknown_scheme_week'
  | 'layout_out_of_date'
  | 'unit_has_versions'
  | 'published_unit_cannot_move'
  | 'layout_renumbers_versioned_units';

export interface RenumberItem {
  id: string;
  title: string;
  from: number;
  to: number;
}

export class LayoutRefusal extends Error {
  readonly code: LayoutErrorCode;
  readonly detail: RenumberItem[] | undefined;
  constructor(code: LayoutErrorCode, detail?: RenumberItem[]) {
    super(code);
    this.name = 'LayoutRefusal';
    this.code = code;
    this.detail = detail;
  }
}

export interface PlannedUnit {
  /** null for a unit that does not exist yet. */
  id: string | null;
  unit_no: number;
  fields: Partial<UnitFields> & { lens?: string };
}

export interface PlannedChapter {
  /** null for a new chapter. */
  id: string | null;
  number: number;
  title: string;
  units: PlannedUnit[];
}

export interface LayoutPlan {
  chapters: PlannedChapter[];
  archived: string[];
  /** False when nothing at all would change (the server then writes nothing). */
  changes: boolean;
  counts: {
    units_created: number;
    units_updated: number;
    units_moved: number;
    units_renumbered: number;
    units_archived: number;
    chapters_created: number;
  };
  /** Units with versions whose number or chapter changes (what needs the confirmation). */
  versioned: RenumberItem[];
}

const KINDS: readonly string[] = ['lesson', 'mini_project', 'term_project', 'revision', 'assessment'];
const STAGES: readonly string[] = ['absorb', 'connect', 'express'];

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed !== '' && trimmed.length <= max ? trimmed : null;
}

function int(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

function fieldsOf(
  raw: unknown,
  weeks: readonly number[],
  requireAll: boolean,
): Partial<UnitFields> & { lens?: string } {
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new LayoutRefusal('invalid_layout_unit');
  const r = raw as Record<string, unknown>;
  const out: Partial<UnitFields> & { lens?: string } = {};
  const need = (key: string): boolean => {
    if (key in r) return true;
    if (requireAll) throw new LayoutRefusal('invalid_layout_unit');
    return false;
  };
  if (need('title')) {
    const t = text(r.title, 200);
    if (t === null) throw new LayoutRefusal('invalid_layout_unit');
    out.title = t;
  }
  if (need('objective')) {
    const t = text(r.objective, 2000);
    if (t === null) throw new LayoutRefusal('invalid_layout_unit');
    out.objective = t;
  }
  if (need('kind')) {
    if (typeof r.kind !== 'string' || !KINDS.includes(r.kind)) throw new LayoutRefusal('invalid_layout_unit');
    out.kind = r.kind as UnitKind;
  }
  if (need('stage')) {
    if (typeof r.stage !== 'string' || !STAGES.includes(r.stage)) throw new LayoutRefusal('invalid_layout_unit');
    out.stage = r.stage as Stage;
  }
  if ('periods' in r) {
    const n = int(r.periods, 1, 10);
    if (n === null) throw new LayoutRefusal('invalid_layout_unit');
    out.periods = n;
  } else if (requireAll) {
    out.periods = 1;
  }
  if ('week_no' in r) {
    if (r.week_no === null) {
      out.week_no = null;
    } else {
      const n = int(r.week_no, 1, 15);
      if (n === null) throw new LayoutRefusal('invalid_layout_unit');
      if (!weeks.includes(n)) throw new LayoutRefusal('unknown_scheme_week');
      out.week_no = n;
    }
  }
  if (requireAll && 'lens' in r && r.lens !== null) {
    const t = text(r.lens, 200);
    if (t === null) throw new LayoutRefusal('invalid_layout_unit');
    out.lens = t;
  }
  return out;
}

function differs(unit: LayoutUnit, fields: Partial<UnitFields>): boolean {
  return (
    (fields.title !== undefined && fields.title !== unit.title) ||
    (fields.objective !== undefined && fields.objective !== unit.objective) ||
    (fields.kind !== undefined && fields.kind !== unit.kind) ||
    (fields.stage !== undefined && fields.stage !== unit.stage) ||
    (fields.periods !== undefined && fields.periods !== unit.periods) ||
    (fields.week_no !== undefined && fields.week_no !== unit.week_no)
  );
}

interface Item {
  pos: number;
  unitId: string | null;
  rank: number;
  fields: Partial<UnitFields> & { lens?: string };
}

/** Plans a layout exactly as `private.apply_unit_layout` validates and applies it. Throws `LayoutRefusal`. */
export function planLayout(
  model: LayoutModel,
  doc: LayoutDoc,
  options: { confirmRenumber?: boolean } = {},
): LayoutPlan {
  if (!doc || !Array.isArray(doc.chapters) || doc.chapters.length < 1 || doc.chapters.length > 50) {
    throw new LayoutRefusal('invalid_unit_layout');
  }
  const removed: string[] = [];
  for (const id of doc.removed ?? []) {
    if (typeof id !== 'string' || removed.includes(id)) throw new LayoutRefusal('invalid_unit_layout');
    removed.push(id);
  }

  const unitById = new Map(model.units.map((u) => [u.id, u]));
  const chapterById = new Map(model.chapters.map((c) => [c.id, c]));
  const base = model.chapters.reduce((max, c) => Math.max(max, c.number), 0);

  const chapterIds: string[] = [];
  const unitIds: string[] = [];
  const chapters: PlannedChapter[] = [];
  const items: Item[] = [];
  let seenNew = false;
  let lastNo = 0;
  let newChapters = 0;
  let rank = 0;

  doc.chapters.forEach((entry, index) => {
    const pos = index + 1;
    if (typeof entry !== 'object' || entry === null || !Array.isArray(entry.units)) {
      throw new LayoutRefusal('invalid_unit_layout');
    }
    if (entry.units.length < CHAPTER_MIN_UNITS || entry.units.length > CHAPTER_MAX_UNITS) {
      throw new LayoutRefusal('chapter_unit_count_invalid');
    }
    if ('id' in entry && entry.id !== undefined) {
      const chapter = chapterById.get(entry.id);
      if (chapterIds.includes(entry.id)) throw new LayoutRefusal('invalid_unit_layout');
      if (!chapter) throw new LayoutRefusal('chapter_not_in_scheme');
      if (seenNew || chapter.number <= lastNo) throw new LayoutRefusal('chapter_order_changed');
      lastNo = chapter.number;
      chapterIds.push(chapter.id);
      chapters.push({ id: chapter.id, number: chapter.number, title: chapter.title, units: [] });
    } else {
      const title = 'new' in entry ? text(entry.new?.title, 200) : null;
      if (title === null) throw new LayoutRefusal('invalid_unit_layout');
      seenNew = true;
      newChapters += 1;
      chapters.push({ id: null, number: base + newChapters, title, units: [] });
    }
    for (const unit of entry.units) {
      if (typeof unit !== 'object' || unit === null) throw new LayoutRefusal('invalid_unit_layout');
      rank += 1;
      let unitId: string | null = null;
      let fields: Item['fields'];
      if ('id' in unit && unit.id !== undefined) {
        unitId = unit.id;
        if (typeof unitId !== 'string') throw new LayoutRefusal('invalid_unit_layout');
        if (unitIds.includes(unitId) || removed.includes(unitId)) {
          throw new LayoutRefusal('duplicate_unit_in_layout');
        }
        if (!unitById.has(unitId)) throw new LayoutRefusal('unit_not_in_scheme');
        unitIds.push(unitId);
        fields = fieldsOf(unit.set, model.weeks, false);
      } else if ('new' in unit && typeof unit.new === 'object' && unit.new !== null) {
        fields = fieldsOf(unit.new, model.weeks, true);
      } else {
        throw new LayoutRefusal('invalid_unit_layout');
      }
      items.push({ pos, unitId, rank, fields });
      chapters[pos - 1]?.units.push({ id: unitId, unit_no: rank, fields });
    }
  });

  if (model.chapters.some((c) => !chapterIds.includes(c.id))) throw new LayoutRefusal('layout_out_of_date');
  if (model.units.some((u) => !unitIds.includes(u.id) && !removed.includes(u.id))) {
    throw new LayoutRefusal('layout_out_of_date');
  }
  for (const id of removed) if (!unitById.has(id)) throw new LayoutRefusal('unit_not_in_scheme');

  // what changes
  const counts = {
    units_created: 0,
    units_updated: 0,
    units_moved: 0,
    units_renumbered: 0,
    units_archived: 0,
    chapters_created: newChapters,
  };
  const changedPos: string[] = [];
  const changedFields: string[] = [];
  for (const item of items) {
    if (item.unitId === null) continue;
    const unit = unitById.get(item.unitId);
    if (!unit) continue;
    const target = chapters[item.pos - 1]?.id ?? null;
    const moved = target !== unit.chapter_id;
    const renumbered = unit.unit_no !== item.rank;
    if (moved) counts.units_moved += 1;
    if (renumbered) counts.units_renumbered += 1;
    if (moved || renumbered) changedPos.push(unit.id);
    if (differs(unit, item.fields)) {
      changedFields.push(unit.id);
      counts.units_updated += 1;
    }
  }
  const created = items.filter((item) => item.unitId === null).length;
  counts.units_created = created;
  counts.units_archived = removed.length;

  const changes =
    changedPos.length > 0 || changedFields.length > 0 || removed.length > 0 || created > 0 || newChapters > 0;
  if (!changes) {
    return { chapters, archived: [], changes: false, counts: { ...counts, units_archived: 0 }, versioned: [] };
  }

  // versions (the server checks these after locking the rows)
  const versioned: RenumberItem[] = [];
  for (const item of items) {
    if (item.unitId === null) continue;
    const unit = unitById.get(item.unitId);
    if (!unit || !(changedPos.includes(unit.id) || changedFields.includes(unit.id))) continue;
    if (!unit.hasVersions) continue;
    if (changedFields.includes(unit.id)) throw new LayoutRefusal('unit_has_versions');
    const target = chapters[item.pos - 1]?.id ?? null;
    if (target !== unit.chapter_id && unit.published) throw new LayoutRefusal('published_unit_cannot_move');
    versioned.push({ id: unit.id, title: unit.title, from: unit.unit_no, to: item.rank });
  }
  for (const id of removed) {
    if (unitById.get(id)?.hasVersions) throw new LayoutRefusal('unit_has_versions');
  }
  if (versioned.length > 0 && !options.confirmRenumber) {
    throw new LayoutRefusal('layout_renumbers_versioned_units', versioned);
  }
  return { chapters, archived: removed, changes: true, counts, versioned };
}

/** The numbers a layout would give, without any of the version rules: for the live preview in the planner. */
export function previewNumbers(doc: LayoutDoc): Map<string, number> {
  const out = new Map<string, number>();
  let rank = 0;
  for (const chapter of doc.chapters) {
    for (const unit of chapter.units) {
      rank += 1;
      if ('id' in unit && unit.id) out.set(unit.id, rank);
    }
  }
  return out;
}
