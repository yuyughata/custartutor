// Editing operations on the working copy of a unit, as immutable updaters. Plain field edits go through
// `setAt`/`removeAt` (path.ts); this file holds the operations with rules of their own: adding things with
// generated ids, removing things together with the references that would otherwise dangle, duplicating a section
// together with fresh copies of its questions, and renumbering. Every function returns a new unit (and, where a
// person should be told what else changed, the notes). No React, no I/O.
import {
  LAYER_FOR_TYPE,
  type BlockType,
  type Question,
  type QuestionKind,
  type SectionType,
  type UnitContent,
} from '@custar/content-schema';
import { newBlock, newQuestion, newSection, newTutorNode } from './factories';
import {
  NODE_ID_PREFIX,
  VARIANT_ID_PREFIX,
  allIdsIn,
  nextFreeId,
  questionIdPrefix,
  sectionIdPrefix,
} from './ids';
import { appendAt, getAt, insertAt, listAt, moveItem, removeAt, setAt, type Path } from './path';

export type Unit = UnitContent;
type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface OpResult {
  unit: Unit;
  /** What else changed, in plain words, for the confirmation and the "undo" hint. */
  notes: string[];
}

export interface Added {
  unit: Unit;
  id: string;
}

// --- lookups ---------------------------------------------------------------------------------------------------------

export function sections(unit: Unit): Rec[] {
  return listAt<Rec>(unit, ['sections']).filter(isRec);
}

export function questionMap(unit: Unit): Record<string, Rec> {
  const value = getAt(unit, ['questions']);
  return isRec(value) ? (value as Record<string, Rec>) : {};
}

export function questionIds(unit: Unit): string[] {
  return Object.keys(questionMap(unit));
}

export function sectionIdAt(unit: Unit, index: number): string {
  const id = getAt(unit, ['sections', index, 'id']);
  return typeof id === 'string' ? id : '';
}

/** Where a question is used, as short phrases ("section Practice time", "workbook tier 2"). */
export function questionUsage(unit: Unit, id: string): string[] {
  const out: string[] = [];
  sections(unit).forEach((section, index) => {
    const blocks = listAt<Rec>(section, ['blocks']);
    if (blocks.some((b) => isRec(b) && b.type === 'question' && b.question_id === id)) {
      out.push(`section ${index + 1} (${String(section.heading ?? section.id ?? '')})`);
    }
    for (const node of listAt<Rec>(section, ['tutor_script', 'nodes'])) {
      if (getAt(node, ['expect', 'question_id']) === id) {
        out.push(`tutor script of section ${index + 1}`);
        break;
      }
    }
  });
  for (const [t, tier] of listAt<Rec>(unit, ['workbook', 'tiers']).entries()) {
    if (listAt<string>(tier, ['question_ids']).includes(id)) out.push(`workbook tier ${String(tier.tier ?? t + 1)}`);
  }
  if (listAt<string>(unit, ['workbook', 'quick_answer_drill', 'question_ids']).includes(id)) {
    out.push('the quick-answer drill');
  }
  if (getAt(unit, ['workbook', 'application_task_id']) === id) out.push('the application task');
  for (const variant of listAt<Rec>(unit, ['workbook', 'practice_variants'])) {
    if (listAt<string>(variant, ['question_ids']).includes(id)) {
      out.push(`practice set ${String(variant.id ?? '')}`);
    }
  }
  return out;
}

/** Where a section is used outside its own place in the list. */
export function sectionUsage(unit: Unit, id: string): string[] {
  const out: string[] = [];
  listAt<Rec>(unit, ['session_plan']).forEach((period, index) => {
    if (listAt<string>(period, ['sections']).includes(id)) {
      out.push(`period ${String(period.period ?? index + 1)} of the session plan`);
    }
  });
  if (listAt<Rec>(unit, ['teacher_manual', 'script']).some((row) => row.section_id === id)) {
    out.push("the teacher's manual script");
  }
  if (listAt<Rec>(unit, ['teacher_manual', 'helper_script']).some((row) => row.section_id === id)) {
    out.push('the helper script');
  }
  return out;
}

// --- sections ------------------------------------------------------------------------------------------------------

/** Adds a section of `type` after `afterIndex` (the end by default). `taken` = ids in use or ever published. */
export function addSection(
  unit: Unit,
  type: SectionType,
  taken: ReadonlySet<string>,
  afterIndex?: number,
): Added {
  const used = new Set([...taken, ...allIdsIn(unit)]);
  const id = nextFreeId(sectionIdPrefix(type), used);
  const at = afterIndex === undefined ? Number.MAX_SAFE_INTEGER : afterIndex + 1;
  return { unit: insertAt(unit, ['sections'], at, newSection(type, id)), id };
}

export function setSectionType(unit: Unit, index: number, type: SectionType): Unit {
  const changed = setAt(unit, ['sections', index, 'type'], type);
  return setAt(changed, ['sections', index, 'layer'], LAYER_FOR_TYPE[type]);
}

export function moveSection(unit: Unit, from: number, to: number): Unit {
  return moveItem(unit, ['sections'], from, to);
}

/**
 * Removes a section and every reference to its id (session plan, manual script, helper script). The questions placed
 * in it stay in the unit (they may also be in the workbook); they show up as "not placed in a section".
 */
export function removeSection(unit: Unit, index: number): OpResult {
  const id = sectionIdAt(unit, index);
  const notes: string[] = [];
  let next = removeAt(unit, ['sections', index]);
  if (id === '') return { unit: next, notes };

  const plan = listAt<Rec>(next, ['session_plan']);
  if (plan.some((period) => listAt<string>(period, ['sections']).includes(id))) {
    next = setAt(
      next,
      ['session_plan'],
      plan.map((period) => ({
        ...period,
        sections: listAt<string>(period, ['sections']).filter((s) => s !== id),
      })),
    );
    notes.push('removed it from the session plan');
  }
  for (const key of ['script', 'helper_script'] as const) {
    const rows = listAt<Rec>(next, ['teacher_manual', key]);
    if (rows.some((row) => row.section_id === id)) {
      next = setAt(next, ['teacher_manual', key], rows.filter((row) => row.section_id !== id));
      notes.push(key === 'script' ? "removed its row from the teacher's script" : 'removed its helper steps');
    }
  }
  return { unit: next, notes };
}

/** Clones a question under a new id; returns the clone. */
function cloneQuestion(question: Rec, id: string): Rec {
  return { ...(structuredClone(question) as Rec), id };
}

/**
 * Duplicates a section after itself: new id, "(copy)" heading, blocks copied; every question placed in it is copied
 * under a fresh id and the copy's blocks and tutor script point at the copies, so the two sections do not share a
 * question. The copy is not in the session plan or the manual yet.
 */
export function duplicateSection(unit: Unit, index: number, taken: ReadonlySet<string>): Added {
  const source = sections(unit)[index];
  if (!source) return { unit, id: '' };
  const type = (typeof source.type === 'string' ? source.type : 'concept') as SectionType;
  const used = new Set([...taken, ...allIdsIn(unit)]);
  const id = nextFreeId(sectionIdPrefix(type), used);
  used.add(id);

  const map = questionMap(unit);
  const renamed = new Map<string, string>();
  let questions = { ...map };
  const blocks = listAt<Rec>(source, ['blocks']).map((block) => {
    const copy = structuredClone(block) as Rec;
    if (copy.type === 'question' && typeof copy.question_id === 'string') {
      const original = map[copy.question_id];
      if (original) {
        let fresh = renamed.get(copy.question_id);
        if (!fresh) {
          const kind = (typeof original.kind === 'string' ? original.kind : 'mcq') as QuestionKind;
          fresh = nextFreeId(questionIdPrefix(kind), used);
          used.add(fresh);
          renamed.set(copy.question_id, fresh);
          questions = { ...questions, [fresh]: cloneQuestion(original, fresh) };
        }
        copy.question_id = fresh;
      }
    }
    return copy;
  });
  const script = isRec(source.tutor_script) ? (structuredClone(source.tutor_script) as Rec) : undefined;
  if (script) {
    for (const node of listAt<Rec>(script, ['nodes'])) {
      const expectId = getAt(node, ['expect', 'question_id']);
      if (typeof expectId === 'string' && renamed.has(expectId)) {
        node.expect = { ...(node.expect as Rec), question_id: renamed.get(expectId) };
      }
    }
  }
  const copy: Rec = {
    ...structuredClone(source),
    id,
    heading: `${String(source.heading ?? '')} (copy)`,
    blocks,
    ...(script ? { tutor_script: script } : {}),
  };
  let next = insertAt(unit, ['sections'], index + 1, copy);
  if (renamed.size > 0) next = setAt(next, ['questions'], questions);
  return { unit: next, id };
}

// --- blocks ----------------------------------------------------------------------------------------------------------

export function addBlock(unit: Unit, sectionIndex: number, type: BlockType, at?: number): Unit {
  return insertAt(
    unit,
    ['sections', sectionIndex, 'blocks'],
    at ?? Number.MAX_SAFE_INTEGER,
    newBlock(type),
  );
}

export function removeBlock(unit: Unit, sectionIndex: number, blockIndex: number): Unit {
  return removeAt(unit, ['sections', sectionIndex, 'blocks', blockIndex]);
}

export function moveBlock(unit: Unit, sectionIndex: number, from: number, to: number): Unit {
  return moveItem(unit, ['sections', sectionIndex, 'blocks'], from, to);
}

/** Duplicates a block after itself. A question block is not duplicated (a question appears once in a flow). */
export function duplicateBlock(unit: Unit, sectionIndex: number, blockIndex: number): Unit {
  const block = getAt(unit, ['sections', sectionIndex, 'blocks', blockIndex]);
  if (!isRec(block) || block.type === 'question') return unit;
  return insertAt(unit, ['sections', sectionIndex, 'blocks'], blockIndex + 1, structuredClone(block));
}

// --- questions -------------------------------------------------------------------------------------------------------

export interface AddQuestionOptions {
  tier?: 1 | 2 | 3;
  /** Also place the question in this section as a question block. */
  sectionIndex?: number;
  /** Place it after this block index; the end by default. */
  blockIndex?: number;
}

export function addQuestion(
  unit: Unit,
  kind: QuestionKind,
  taken: ReadonlySet<string>,
  options: AddQuestionOptions = {},
): Added {
  const used = new Set([...taken, ...allIdsIn(unit)]);
  const id = nextFreeId(questionIdPrefix(kind), used);
  let next = setAt(unit, ['questions', id], newQuestion(kind, id, options.tier ?? 1) as unknown);
  if (options.sectionIndex !== undefined) {
    next = insertAt(
      next,
      ['sections', options.sectionIndex, 'blocks'],
      options.blockIndex === undefined ? Number.MAX_SAFE_INTEGER : options.blockIndex + 1,
      { type: 'question', question_id: id },
    );
  }
  return { unit: next, id };
}

/** Puts a copy of a question into the map under a fresh id, right after the original. */
export function duplicateQuestion(unit: Unit, id: string, taken: ReadonlySet<string>): Added {
  const map = questionMap(unit);
  const original = map[id];
  if (!original) return { unit, id: '' };
  const used = new Set([...taken, ...allIdsIn(unit)]);
  const kind = (typeof original.kind === 'string' ? original.kind : 'mcq') as QuestionKind;
  const fresh = nextFreeId(questionIdPrefix(kind), used);
  const entries: [string, Rec][] = [];
  for (const [key, value] of Object.entries(map)) {
    entries.push([key, value]);
    if (key === id) entries.push([fresh, cloneQuestion(original, fresh)]);
  }
  return { unit: setAt(unit, ['questions'], Object.fromEntries(entries)), id: fresh };
}

/**
 * Removes a question and every reference to it: question blocks in sections, workbook tiers, the drill, practice
 * sets and tutor-script `expect`s. The application task is cleared (the schema then asks for a new one).
 */
export function removeQuestion(unit: Unit, id: string): OpResult {
  if (!(id in questionMap(unit))) return { unit, notes: [] };
  const notes: string[] = [];
  let next = removeAt(unit, ['questions', id]);

  let blocksRemoved = 0;
  sections(next).forEach((section, si) => {
    const blocks = listAt<Rec>(section, ['blocks']);
    const kept = blocks.filter((b) => !(isRec(b) && b.type === 'question' && b.question_id === id));
    if (kept.length !== blocks.length) {
      blocksRemoved += blocks.length - kept.length;
      next = setAt(next, ['sections', si, 'blocks'], kept);
    }
  });
  if (blocksRemoved > 0) notes.push(`removed ${blocksRemoved} question block${blocksRemoved === 1 ? '' : 's'} from sections`);

  let nodesCleared = 0;
  const clearNodes = (scriptPath: Path): void => {
    const nodes = listAt<Rec>(next, [...scriptPath, 'nodes']);
    if (nodes.some((n) => getAt(n, ['expect', 'question_id']) === id)) {
      nodesCleared += nodes.filter((n) => getAt(n, ['expect', 'question_id']) === id).length;
      next = setAt(
        next,
        [...scriptPath, 'nodes'],
        nodes.map((n) => {
          if (getAt(n, ['expect', 'question_id']) !== id) return n;
          const { expect: _gone, ...rest } = n;
          return rest;
        }),
      );
    }
  };
  sections(next).forEach((_, si) => clearNodes(['sections', si, 'tutor_script']));
  clearNodes(['tutor_script']);
  if (nodesCleared > 0) notes.push(`tutor lines no longer wait for it (${nodesCleared})`);

  const tiers = listAt<Rec>(next, ['workbook', 'tiers']);
  if (tiers.some((t) => listAt<string>(t, ['question_ids']).includes(id))) {
    next = setAt(
      next,
      ['workbook', 'tiers'],
      tiers.map((t) => ({ ...t, question_ids: listAt<string>(t, ['question_ids']).filter((q) => q !== id) })),
    );
    notes.push('removed it from the workbook tiers');
  }
  if (listAt<string>(next, ['workbook', 'quick_answer_drill', 'question_ids']).includes(id)) {
    next = setAt(
      next,
      ['workbook', 'quick_answer_drill', 'question_ids'],
      listAt<string>(next, ['workbook', 'quick_answer_drill', 'question_ids']).filter((q) => q !== id),
    );
    notes.push('removed it from the quick-answer drill');
  }
  const variants = listAt<Rec>(next, ['workbook', 'practice_variants']);
  if (variants.some((v) => listAt<string>(v, ['question_ids']).includes(id))) {
    next = setAt(
      next,
      ['workbook', 'practice_variants'],
      variants.map((v) => ({ ...v, question_ids: listAt<string>(v, ['question_ids']).filter((q) => q !== id) })),
    );
    notes.push('removed it from the practice sets');
  }
  if (getAt(next, ['workbook', 'application_task_id']) === id) {
    next = setAt(next, ['workbook', 'application_task_id'], '');
    notes.push('the application task needs another question');
  }
  return { unit: next, notes };
}

// --- tutor script ------------------------------------------------------------------------------------------------------

/** The path of a tutor script: a section's, or the unit's own (projects). */
export function scriptPath(sectionIndex: number | null): Path {
  return sectionIndex === null ? ['tutor_script'] : ['sections', sectionIndex, 'tutor_script'];
}

export function addNode(unit: Unit, sectionIndex: number | null, taken: ReadonlySet<string>): Added {
  const path = scriptPath(sectionIndex);
  const nodeIds = listAt<Rec>(unit, [...path, 'nodes']).map((n) => String(n.id ?? ''));
  const used = new Set([...taken, ...nodeIds]);
  const id = nextFreeId(NODE_ID_PREFIX, used);
  const node = newTutorNode(id);
  return {
    unit: appendAt(isRec(getAt(unit, path)) ? unit : setAt(unit, path, { nodes: [] }), [...path, 'nodes'], node),
    id,
  };
}

/** Removes a node; nodes that jumped to it (`next`) lose that jump and simply continue in order. */
export function removeNode(unit: Unit, sectionIndex: number | null, nodeIndex: number): OpResult {
  const path = scriptPath(sectionIndex);
  const id = getAt(unit, [...path, 'nodes', nodeIndex, 'id']);
  const notes: string[] = [];
  let next = removeAt(unit, [...path, 'nodes', nodeIndex]);
  const nodes = listAt<Rec>(next, [...path, 'nodes']);
  if (typeof id === 'string' && nodes.some((n) => n.next === id)) {
    next = setAt(
      next,
      [...path, 'nodes'],
      nodes.map((n) => {
        if (n.next !== id) return n;
        const { next: _gone, ...rest } = n;
        return rest;
      }),
    );
    notes.push('lines that jumped to it now continue in order');
  }
  if (nodes.length === 0 && isRec(getAt(next, path))) {
    // A script needs at least one node: removing the last one removes the script.
    next = removeAt(next, path);
    notes.push('the script had no other line, so it was removed');
  }
  return { unit: next, notes };
}

// --- session plan ----------------------------------------------------------------------------------------------------

export const SEGMENTS = ['start', 'teach', 'move_and_do', 'practice', 'close'] as const;

export function addPeriod(unit: Unit): Unit {
  const periods = listAt<Rec>(unit, ['session_plan']);
  return appendAt(unit, ['session_plan'], {
    period: periods.length + 1,
    sections: [],
    minutes: [
      { segment: 'start', minutes: 10 },
      { segment: 'teach', minutes: 15 },
      { segment: 'move_and_do', minutes: 15 },
      { segment: 'practice', minutes: 10 },
      { segment: 'close', minutes: 10 },
    ],
  });
}

/** Removes a period and renumbers the rest 1, 2, 3. */
export function removePeriod(unit: Unit, index: number): Unit {
  const next = removeAt(unit, ['session_plan', index]);
  const periods = listAt<Rec>(next, ['session_plan']);
  return setAt(
    next,
    ['session_plan'],
    periods.map((p, i) => ({ ...p, period: i + 1 })),
  );
}

export function periodMinutes(unit: Unit, index: number): number {
  return listAt<Rec>(unit, ['session_plan', index, 'minutes']).reduce(
    (sum, m) => sum + (typeof m.minutes === 'number' && Number.isFinite(m.minutes) ? m.minutes : 0),
    0,
  );
}

/** Sections that are in no period of the session plan. */
export function sectionsOutsidePlan(unit: Unit): string[] {
  const planned = new Set(listAt<Rec>(unit, ['session_plan']).flatMap((p) => listAt<string>(p, ['sections'])));
  return sections(unit)
    .map((s) => String(s.id ?? ''))
    .filter((id) => id !== '' && !planned.has(id));
}

// --- workbook and manual -------------------------------------------------------------------------------------------

export function addVariant(unit: Unit, taken: ReadonlySet<string>): Added {
  const used = new Set([...taken, ...allIdsIn(unit)]);
  const id = nextFreeId(VARIANT_ID_PREFIX, used);
  return { unit: appendAt(unit, ['workbook', 'practice_variants'], { id, question_ids: [] }), id };
}

/** Adds a tier slot (1 to 3) that is missing. */
export function addTier(unit: Unit, tier: 1 | 2 | 3): Unit {
  const tiers = listAt<Rec>(unit, ['workbook', 'tiers']);
  if (tiers.some((t) => t.tier === tier)) return unit;
  const titles = { 1: "Let's Start Together", 2: 'Now You Try', 3: 'Stretch Yourself' } as const;
  const next = [...tiers, { tier, title: titles[tier], question_ids: [] }].sort(
    (a, b) => Number(a.tier) - Number(b.tier),
  );
  return setAt(unit, ['workbook', 'tiers'], next);
}

/** Adds an empty script row for every section that has none, in section order. */
export function addMissingScriptRows(unit: Unit): Unit {
  const rows = listAt<Rec>(unit, ['teacher_manual', 'script']);
  const have = new Set(rows.map((r) => r.section_id));
  const added = sections(unit)
    .filter((s) => typeof s.id === 'string' && !have.has(s.id))
    .map((s) => ({ section_id: s.id, say: '', ask: '', watch_for: '' }));
  return added.length === 0 ? unit : setAt(unit, ['teacher_manual', 'script'], [...rows, ...added]);
}

export function questionOptions(unit: Unit): { id: string; label: string }[] {
  return Object.entries(questionMap(unit)).map(([id, question]) => ({
    id,
    label: `${id}: ${String(question.prompt ?? '').slice(0, 60)}`,
  }));
}

/** Questions that no section places (so a child reaches them only through the workbook, if at all). */
export function questionsNotInSections(unit: Unit): string[] {
  const placed = new Set<string>();
  for (const section of sections(unit)) {
    for (const block of listAt<Rec>(section, ['blocks'])) {
      if (isRec(block) && block.type === 'question' && typeof block.question_id === 'string') {
        placed.add(block.question_id);
      }
    }
  }
  return questionIds(unit).filter((id) => !placed.has(id));
}

export type { Question };
