// Reconciling two people's edits. Saving a version names the version it was based on (`base_version_id`); when someone
// else saved in the meantime the server refuses with `stale_base` and nothing is written. There is no "save a separate
// copy": the person has to bring the two together. This does it by item: the header, each section (by id), each
// question (by id), the order of the sections, and each remaining part of the unit (session plan, workbook, manual,
// project fields, scoring). An item only one side changed is taken from that side; an item both changed the same way is
// not a clash; an item both changed differently is a clash and the person chooses whose version to keep.
//
// Pure: no React, no I/O. The merged unit is only a proposal; the editor validates it like any other working copy.
import { sameContent } from './autosave';

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The header fields the planner owns; they are stamped from the unit row on save, so they never clash. */
const STAMPED = ['chapter', 'unit_no', 'week_no'] as const;

export const ORDER_KEY = 'sections:order';

function sectionIds(unit: unknown): string[] {
  if (!isRec(unit) || !Array.isArray(unit.sections)) return [];
  return unit.sections.map((s, i) => (isRec(s) && typeof s.id === 'string' ? s.id : `#${i}`));
}

/** A unit as a map of mergeable items. The order of the sections is its own item (`sections:order`). */
export function itemsOf(unit: unknown): Map<string, unknown> {
  const items = new Map<string, unknown>();
  if (!isRec(unit)) return items;
  for (const [name, value] of Object.entries(unit)) {
    if (name === 'sections' && Array.isArray(value)) {
      value.forEach((section, i) => {
        const id = isRec(section) && typeof section.id === 'string' ? section.id : `#${i}`;
        items.set(`section:${id}`, section);
      });
      items.set(ORDER_KEY, sectionIds(unit));
    } else if (name === 'questions' && isRec(value)) {
      for (const [id, question] of Object.entries(value)) items.set(`question:${id}`, question);
    } else if (name === 'header' && isRec(value)) {
      const rest: Rec = { ...value };
      for (const field of STAMPED) delete rest[field];
      items.set('header', rest);
    } else {
      items.set(`top:${name}`, value);
    }
  }
  return items;
}

export type Change = 'added' | 'removed' | 'changed';

export interface ItemChange {
  key: string;
  label: string;
  change: Change;
}

/** A readable name for an item, for the lists the person reads. */
export function labelOf(key: string, ...units: unknown[]): string {
  if (key === 'header') return 'Header (title, objective, stage, theme)';
  if (key === ORDER_KEY) return 'The order of the sections';
  if (key.startsWith('section:')) {
    const id = key.slice('section:'.length);
    for (const unit of units) {
      const found =
        isRec(unit) && Array.isArray(unit.sections)
          ? unit.sections.find((s) => isRec(s) && s.id === id)
          : undefined;
      if (isRec(found) && typeof found.heading === 'string' && found.heading.trim() !== '')
        return `Section "${found.heading}" (${id})`;
    }
    return `Section ${id}`;
  }
  if (key.startsWith('question:')) return `Question ${key.slice('question:'.length)}`;
  const top = key.slice('top:'.length);
  const names: Record<string, string> = {
    session_plan: 'Session plan',
    workbook: 'Workbook',
    teacher_manual: "Teacher's manual",
    tutor_script: 'Tutor script',
    scoring: 'Scoring',
    brief: 'Project brief',
    steps: 'Project steps',
    materials: 'Materials',
    rubric: 'Rubric',
    evidence_options: 'Ways to show the work',
    reflection_prompts: 'Reflection prompts',
    kind: 'Kind of unit',
    schema_version: 'Schema version',
  };
  return names[top] ?? top;
}

/** What `other` changed compared with `base`, item by item. */
export function changesBetween(base: unknown, other: unknown): ItemChange[] {
  const b = itemsOf(base);
  const o = itemsOf(other);
  const out: ItemChange[] = [];
  const keys = new Set([...b.keys(), ...o.keys()]);
  for (const key of keys) {
    const had = b.has(key);
    const has = o.has(key);
    if (had && has) {
      if (key === ORDER_KEY) {
        if (!orderChanged(b.get(key) as string[], o.get(key) as string[])) continue;
      } else if (sameContent(b.get(key), o.get(key))) continue;
      out.push({ key, label: labelOf(key, base, other), change: 'changed' });
    } else if (has) {
      if (key === ORDER_KEY) continue;
      out.push({ key, label: labelOf(key, other), change: 'added' });
    } else if (had) {
      if (key === ORDER_KEY) continue;
      out.push({ key, label: labelOf(key, base), change: 'removed' });
    }
  }
  return out;
}

/** The sections that exist in both lists, in the order each list has them. */
function common(a: readonly string[], b: readonly string[]): string[] {
  const inB = new Set(b);
  return a.filter((id) => inB.has(id));
}

/** Did the sections both lists share change their relative order? (Adding or removing a section alone is not a reorder.) */
function orderChanged(before: readonly string[], after: readonly string[]): boolean {
  const left = common(before, after);
  const right = common(after, before);
  return left.length !== right.length || left.some((id, i) => id !== right[i]);
}

export interface Clash {
  key: string;
  label: string;
  /** What each side did to the item. */
  mine: Change;
  theirs: Change;
}

export type Choice = 'mine' | 'theirs';

export interface MergeResult {
  /** The merged unit; null while some clash has no choice yet. */
  merged: Rec | null;
  clashes: Clash[];
  /** Items taken from my side without a clash / from theirs. */
  fromMine: string[];
  fromTheirs: string[];
}

function changeOf(
  base: Map<string, unknown>,
  other: Map<string, unknown>,
  key: string,
): Change | null {
  const had = base.has(key);
  const has = other.has(key);
  if (!had && !has) return null;
  if (!had) return 'added';
  if (!has) return 'removed';
  return sameContent(base.get(key), other.get(key)) ? null : 'changed';
}

/** Inserts each id missing from `skeleton` after the id that precedes it in the list it came from. */
function withMembers(
  skeleton: string[],
  members: ReadonlySet<string>,
  sources: readonly (readonly string[])[],
): string[] {
  const out = skeleton.filter((id) => members.has(id));
  for (const source of sources) {
    source.forEach((id, index) => {
      if (!members.has(id) || out.includes(id)) return;
      const before = source
        .slice(0, index)
        .reverse()
        .find((candidate) => out.includes(candidate));
      if (before === undefined) out.unshift(id);
      else out.splice(out.indexOf(before) + 1, 0, id);
    });
  }
  return out;
}

export function mergeUnits(
  base: unknown,
  mine: unknown,
  theirs: unknown,
  choices: Readonly<Record<string, Choice>> = {},
): MergeResult {
  const b = itemsOf(base);
  const m = itemsOf(mine);
  const t = itemsOf(theirs);
  const keys = new Set([...b.keys(), ...m.keys(), ...t.keys()]);
  keys.delete(ORDER_KEY);

  const take = new Map<string, Choice>();
  const clashes: Clash[] = [];
  const fromMine: string[] = [];
  const fromTheirs: string[] = [];
  for (const key of keys) {
    const mineChange = changeOf(b, m, key);
    const theirChange = changeOf(b, t, key);
    if (mineChange === null) {
      take.set(key, 'theirs');
      if (theirChange !== null) fromTheirs.push(key);
    } else if (theirChange === null) {
      take.set(key, 'mine');
      fromMine.push(key);
    } else if (m.has(key) === t.has(key) && sameContent(m.get(key), t.get(key))) {
      take.set(key, 'theirs');
    } else {
      clashes.push({
        key,
        label: labelOf(key, base, mine, theirs),
        mine: mineChange,
        theirs: theirChange,
      });
      const choice = choices[key];
      if (choice) take.set(key, choice);
    }
  }

  // The order of the sections: a reorder by one side only is taken; reorders by both that differ are a clash.
  const baseOrder = sectionIds(base);
  const mineOrder = sectionIds(mine);
  const theirOrder = sectionIds(theirs);
  const iMoved = orderChanged(baseOrder, mineOrder);
  const theyMoved = orderChanged(baseOrder, theirOrder);
  let orderFrom: Choice = 'theirs';
  if (iMoved && !theyMoved) orderFrom = 'mine';
  else if (iMoved && theyMoved) {
    const left = common(mineOrder, theirOrder);
    const right = common(theirOrder, mineOrder);
    if (left.some((id, i) => id !== right[i])) {
      clashes.push({
        key: ORDER_KEY,
        label: labelOf(ORDER_KEY),
        mine: 'changed',
        theirs: 'changed',
      });
      const choice = choices[ORDER_KEY];
      if (choice) orderFrom = choice;
    }
  }
  if (iMoved && !theyMoved) fromMine.push(ORDER_KEY);

  const unresolved = clashes.some((clash) => choices[clash.key] === undefined);
  if (unresolved) return { merged: null, clashes, fromMine, fromTheirs };

  // Build the result on top of their unit, then lay my choices over it.
  const result: Rec = isRec(theirs) ? (structuredClone(theirs) as Rec) : {};
  const sectionsNow = new Map<string, unknown>();
  if (Array.isArray(result.sections)) {
    result.sections.forEach((section, i) =>
      sectionsNow.set(
        isRec(section) && typeof section.id === 'string' ? section.id : `#${i}`,
        section,
      ),
    );
  }
  const questionsNow: Rec = isRec(result.questions) ? { ...result.questions } : {};
  let hasQuestions = isRec(result.questions) || (isRec(mine) && isRec(mine.questions));

  for (const [key, from] of take) {
    if (from !== 'mine') continue;
    const has = m.has(key);
    const value = m.get(key);
    if (key.startsWith('section:')) {
      const id = key.slice('section:'.length);
      if (has) sectionsNow.set(id, structuredClone(value));
      else sectionsNow.delete(id);
    } else if (key.startsWith('question:')) {
      const id = key.slice('question:'.length);
      if (has) questionsNow[id] = structuredClone(value);
      else delete questionsNow[id];
      hasQuestions = true;
    } else if (key === 'header') {
      const stamped: Rec = {};
      const theirHeader = isRec(result.header) ? result.header : {};
      for (const field of STAMPED) if (field in theirHeader) stamped[field] = theirHeader[field];
      result.header = { ...(structuredClone(value) as Rec), ...stamped };
    } else if (key.startsWith('top:')) {
      const name = key.slice('top:'.length);
      if (has) result[name] = structuredClone(value);
      else delete result[name];
    }
  }

  if (
    sectionsNow.size > 0 ||
    Array.isArray(result.sections) ||
    (isRec(mine) && Array.isArray(mine.sections))
  ) {
    const members = new Set(sectionsNow.keys());
    const skeleton = orderFrom === 'mine' ? mineOrder : theirOrder;
    const ordered = withMembers(
      skeleton,
      members,
      orderFrom === 'mine' ? [mineOrder, theirOrder] : [theirOrder, mineOrder],
    );
    result.sections = ordered.map((id) => sectionsNow.get(id));
  }
  if (hasQuestions) result.questions = questionsNow;
  return { merged: result, clashes, fromMine, fromTheirs };
}
