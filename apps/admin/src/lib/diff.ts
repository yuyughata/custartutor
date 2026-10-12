// A pure, section-level diff of two versions of a unit. It works on the raw JSON (not on parsed UnitContent), so
// it still works when one of the two versions does not parse. No React and no I/O.
//
// The result lists what changed per AREA of the unit: the header, each section (matched by its stable id), each
// question (matched by id), the workbook, the teacher's manual, the session plan and any other top-level part.
// Inside a changed section it lists field-level changes with before/after text; `wordDiff` turns a pair of
// strings into highlighted segments.

export type ChangeKind = 'added' | 'removed' | 'changed' | 'moved';
export type DiffArea =
  | 'meta'
  | 'header'
  | 'section'
  | 'question'
  | 'workbook'
  | 'manual'
  | 'session_plan'
  | 'other';

export interface FieldChange {
  /** For example `blocks[2].text`. Indexes are positions in the NEWER version (older, for removals). */
  path: string;
  label: string;
  before: string | null;
  after: string | null;
}

export interface DiffItem {
  area: DiffArea;
  /** Section id, question id, or the area name. */
  id: string;
  title: string;
  change: ChangeKind;
  fields: FieldChange[];
  /** For a section that changed position: 1-based positions. */
  movedFrom?: number;
  movedTo?: number;
}

export interface UnitDiff {
  items: DiffItem[];
  same: boolean;
  counts: Record<ChangeKind, number>;
}

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isRec(a) && isRec(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      if (!deepEqual(a[key], b[key])) return false;
    }
    return true;
  }
  return false;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRec(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

const SUMMARY_MAX = 280;

function clip(text: string): string {
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 1)}…` : text;
}

const TEXT_KEYS = [
  'text',
  'prompt',
  'heading',
  'title',
  'say',
  'term',
  'label',
  'lead',
  'brief',
  'caption',
  'question_id',
] as const;

/** A short human-readable rendering of any JSON value, for the before/after columns. */
export function summarize(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === 'string')) return clip((value as string[]).join(' · '));
    return clip(value.map((item) => summarize(item)).join(' | '));
  }
  if (isRec(value)) {
    const type = typeof value.type === 'string' ? `[${value.type}] ` : '';
    for (const key of TEXT_KEYS) {
      const candidate = value[key];
      if (typeof candidate === 'string' && candidate !== '') return clip(`${type}${candidate}`);
    }
    return clip(`${type}${JSON.stringify(value)}`);
  }
  return String(value);
}

const NOUN: Record<string, string> = {
  blocks: 'Block',
  nodes: 'Tutor node',
  items: 'Item',
  steps: 'Step',
  lines: 'Line',
  pairs: 'Pair',
  options: 'Option',
  tiers: 'Tier',
  script: 'Script entry',
  helper_script: 'Helper script',
  lenses: 'Lens',
  levels: 'Level',
  sections: 'Section',
  question_ids: 'Question id',
  practice_variants: 'Practice set',
};

/** `blocks[2].text` -> `Block 3 › text`. */
export function humanPath(path: string): string {
  const parts: string[] = [];
  const pattern = /([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]/g;
  let previous = '';
  for (const match of path.matchAll(pattern)) {
    if (match[1] !== undefined) {
      previous = match[1];
      parts.push(match[1].replace(/_/g, ' '));
    } else if (match[2] !== undefined) {
      const noun = NOUN[previous] ?? previous.replace(/_/g, ' ');
      parts.pop();
      parts.push(`${noun.charAt(0).toUpperCase()}${noun.slice(1)} ${Number(match[2]) + 1}`);
    }
  }
  return parts.join(' › ');
}

/** Pairs of equal items of the longest common subsequence, as `[indexInA, indexInB]`. */
function lcsPairs(a: readonly string[], b: readonly string[]): [number, number][] {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] =
        a[i] === b[j]
          ? (table[(i + 1) * cols + j + 1] as number) + 1
          : Math.max(table[(i + 1) * cols + j] as number, table[i * cols + j + 1] as number);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if ((table[(i + 1) * cols + j] as number) >= (table[i * cols + j + 1] as number)) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

function field(path: string, before: unknown, after: unknown): FieldChange {
  return {
    path,
    label: humanPath(path) || path,
    before: before === undefined ? null : summarize(before),
    after: after === undefined ? null : summarize(after),
  };
}

function idOf(value: unknown): string | null {
  return isRec(value) && typeof value.id === 'string' ? value.id : null;
}

function allHaveIds(values: readonly unknown[]): boolean {
  return values.length > 0 && values.every((value) => idOf(value) !== null);
}

function diffArray(before: unknown[], after: unknown[], path: string, out: FieldChange[]): void {
  if (allHaveIds(before) && allHaveIds(after)) {
    const beforeById = new Map(before.map((value) => [idOf(value) as string, value]));
    after.forEach((value, index) => {
      const id = idOf(value) as string;
      const old = beforeById.get(id);
      if (old === undefined) out.push(field(`${path}[${index}]`, undefined, value));
      else diffValue(old, value, `${path}[${index}]`, out);
    });
    const afterIds = new Set(after.map((value) => idOf(value)));
    before.forEach((value, index) => {
      if (!afterIds.has(idOf(value))) out.push(field(`${path}[${index}]`, value, undefined));
    });
    return;
  }
  const pairs = lcsPairs(before.map(canonical), after.map(canonical));
  let i = 0;
  let j = 0;
  const flushGap = (endI: number, endJ: number): void => {
    const removed = before.slice(i, endI);
    const added = after.slice(j, endJ);
    const paired = Math.min(removed.length, added.length);
    for (let k = 0; k < paired; k += 1) {
      diffValue(removed[k], added[k], `${path}[${j + k}]`, out);
    }
    for (let k = paired; k < added.length; k += 1) {
      out.push(field(`${path}[${j + k}]`, undefined, added[k]));
    }
    for (let k = paired; k < removed.length; k += 1) {
      out.push(field(`${path}[${i + k}]`, removed[k], undefined));
    }
  };
  for (const [matchI, matchJ] of pairs) {
    flushGap(matchI, matchJ);
    i = matchI + 1;
    j = matchJ + 1;
  }
  flushGap(before.length, after.length);
}

function diffValue(before: unknown, after: unknown, path: string, out: FieldChange[]): void {
  if (deepEqual(before, after)) return;
  if (before === undefined || after === undefined) {
    out.push(field(path, before, after));
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    diffArray(before, after, path, out);
    return;
  }
  if (isRec(before) && isRec(after)) {
    const keys = [...Object.keys(before), ...Object.keys(after).filter((key) => !(key in before))];
    for (const key of keys) {
      diffValue(before[key], after[key], path === '' ? key : `${path}.${key}`, out);
    }
    return;
  }
  out.push(field(path, before, after));
}

/** Field-level changes between two JSON values (exported for tests and for the question/workbook areas). */
export function diffFields(before: unknown, after: unknown, basePath = ''): FieldChange[] {
  const out: FieldChange[] = [];
  diffValue(before, after, basePath, out);
  return out;
}

function headingOf(section: unknown, fallback: string): string {
  return isRec(section) && typeof section.heading === 'string' && section.heading.trim() !== ''
    ? section.heading
    : fallback;
}

function sectionItems(beforeList: unknown[], afterList: unknown[]): DiffItem[] {
  const beforeById = new Map<string, { value: unknown; index: number }>();
  beforeList.forEach((value, index) => {
    const id = idOf(value);
    if (id) beforeById.set(id, { value, index });
  });
  const afterIds = new Set(afterList.map(idOf));
  const common = afterList.map(idOf).filter((id): id is string => id !== null && beforeById.has(id));
  const commonBefore = beforeList
    .map(idOf)
    .filter((id): id is string => id !== null && afterIds.has(id));
  const stable = new Set(lcsPairs(commonBefore, common).map(([, j]) => common[j] as string));

  const items: DiffItem[] = [];
  afterList.forEach((value, index) => {
    const id = idOf(value);
    if (id === null) return;
    const old = beforeById.get(id);
    const title = headingOf(value, id);
    if (!old) {
      items.push({
        area: 'section',
        id,
        title,
        change: 'added',
        fields: [field('heading', undefined, headingOf(value, id))],
      });
      return;
    }
    const fields = diffFields(old.value, value);
    const moved = !stable.has(id);
    if (fields.length > 0) {
      items.push({
        area: 'section',
        id,
        title,
        change: 'changed',
        fields,
        ...(moved ? { movedFrom: old.index + 1, movedTo: index + 1 } : {}),
      });
    } else if (moved) {
      items.push({
        area: 'section',
        id,
        title,
        change: 'moved',
        fields: [],
        movedFrom: old.index + 1,
        movedTo: index + 1,
      });
    }
  });
  beforeList.forEach((value) => {
    const id = idOf(value);
    if (id === null || afterIds.has(id)) return;
    items.push({
      area: 'section',
      id,
      title: headingOf(value, id),
      change: 'removed',
      fields: [field('heading', headingOf(value, id), undefined)],
    });
  });
  return items;
}

function questionItems(before: Rec, after: Rec): DiffItem[] {
  const items: DiffItem[] = [];
  const titleOf = (question: unknown, id: string): string => {
    if (isRec(question) && typeof question.prompt === 'string') {
      return `${id}: ${clip(question.prompt).slice(0, 80)}`;
    }
    return id;
  };
  for (const id of Object.keys(after)) {
    if (!(id in before)) {
      items.push({
        area: 'question',
        id,
        title: titleOf(after[id], id),
        change: 'added',
        fields: [field('prompt', undefined, isRec(after[id]) ? after[id].prompt : after[id])],
      });
      continue;
    }
    const fields = diffFields(before[id], after[id]);
    if (fields.length > 0) {
      items.push({ area: 'question', id, title: titleOf(after[id], id), change: 'changed', fields });
    }
  }
  for (const id of Object.keys(before)) {
    if (!(id in after)) {
      items.push({
        area: 'question',
        id,
        title: titleOf(before[id], id),
        change: 'removed',
        fields: [field('prompt', isRec(before[id]) ? before[id].prompt : before[id], undefined)],
      });
    }
  }
  return items;
}

const TOP_LEVEL_AREAS: { key: string; area: DiffArea; title: string }[] = [
  { key: 'workbook', area: 'workbook', title: 'Workbook' },
  { key: 'teacher_manual', area: 'manual', title: "Teacher's manual" },
  { key: 'session_plan', area: 'session_plan', title: 'Session plan' },
];

const HANDLED_KEYS = new Set([
  'schema_version',
  'kind',
  'header',
  'sections',
  'questions',
  ...TOP_LEVEL_AREAS.map((entry) => entry.key),
]);

/** Compares two versions of a unit (raw JSON). Order of items: meta, header, sections, questions, workbook, manual, plan, other. */
export function diffUnits(before: unknown, after: unknown): UnitDiff {
  const a: Rec = isRec(before) ? before : {};
  const b: Rec = isRec(after) ? after : {};
  const items: DiffItem[] = [];

  const meta = [
    ...diffFields(a.kind, b.kind, 'kind'),
    ...diffFields(a.schema_version, b.schema_version, 'schema_version'),
  ];
  if (meta.length > 0) {
    items.push({ area: 'meta', id: 'meta', title: 'Unit type', change: 'changed', fields: meta });
  }
  const header = diffFields(a.header, b.header);
  if (header.length > 0) {
    items.push({ area: 'header', id: 'header', title: 'Unit header', change: 'changed', fields: header });
  }
  items.push(
    ...sectionItems(
      Array.isArray(a.sections) ? a.sections : [],
      Array.isArray(b.sections) ? b.sections : [],
    ),
  );
  items.push(...questionItems(isRec(a.questions) ? a.questions : {}, isRec(b.questions) ? b.questions : {}));
  for (const { key, area, title } of TOP_LEVEL_AREAS) {
    const fields = diffFields(a[key], b[key]);
    if (fields.length > 0) {
      items.push({ area, id: key, title, change: 'changed', fields });
    }
  }
  const otherKeys = new Set([...Object.keys(a), ...Object.keys(b)].filter((key) => !HANDLED_KEYS.has(key)));
  for (const key of otherKeys) {
    const fields = diffFields(a[key], b[key], key);
    if (fields.length > 0) {
      items.push({
        area: 'other',
        id: key,
        title: key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()),
        change: 'changed',
        fields,
      });
    }
  }

  const counts: Record<ChangeKind, number> = { added: 0, removed: 0, changed: 0, moved: 0 };
  for (const item of items) counts[item.change] += 1;
  return { items, same: items.length === 0, counts };
}

// ---------------------------------------------------------------------------------------------
// Word-level highlighting
// ---------------------------------------------------------------------------------------------

export interface WordSegment {
  text: string;
  kind: 'same' | 'added' | 'removed';
}

function tokenize(text: string): string[] {
  return text.match(/\s+|[^\s]+/g) ?? [];
}

/** Word-level diff of two strings, for highlighting inside a changed field. Whitespace tokens are kept. */
export function wordDiff(before: string, after: string): WordSegment[] {
  const a = tokenize(before);
  const b = tokenize(after);
  const pairs = lcsPairs(a, b);
  const segments: WordSegment[] = [];
  const push = (text: string, kind: WordSegment['kind']): void => {
    const last = segments[segments.length - 1];
    if (last && last.kind === kind) last.text += text;
    else segments.push({ text, kind });
  };
  let i = 0;
  let j = 0;
  for (const [matchI, matchJ] of pairs) {
    while (i < matchI) push(a[i++] as string, 'removed');
    while (j < matchJ) push(b[j++] as string, 'added');
    push(a[matchI] as string, 'same');
    i = matchI + 1;
    j = matchJ + 1;
  }
  while (i < a.length) push(a[i++] as string, 'removed');
  while (j < b.length) push(b[j++] as string, 'added');
  return segments;
}
