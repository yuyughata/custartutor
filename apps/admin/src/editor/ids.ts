// Generated ids for things a person adds by hand. They are deterministic slugs: a prefix plus the next free
// number (`practice_2`, `q_mcq_3`, `n_4`). An existing id is never changed by anything in the editor: there is no
// rename operation at all, because progress, item analysis and the tutor refer to ids (content-schema README,
// "The stable-ID rule"). `taken` should hold every id the unit has now AND every id any published snapshot ever had,
// so a number is not handed out twice and a published id is never reused for something else.
import { Id, type SectionType, type QuestionKind } from '@custar/content-schema';

export function nextFreeId(prefix: string, taken: ReadonlySet<string>): string {
  const base = prefix.replace(/[^a-z0-9_]+/g, '_').replace(/^[^a-z]+/, '').replace(/_+$/, '') || 'item';
  for (let n = 1; n < 10_000; n += 1) {
    const candidate = `${base}_${n}`.slice(-64);
    if (!taken.has(candidate) && Id.safeParse(candidate).success) return candidate;
  }
  throw new Error(`No free id for ${prefix}`);
}

export function sectionIdPrefix(type: SectionType): string {
  return type;
}

export function questionIdPrefix(kind: QuestionKind): string {
  return `q_${kind}`;
}

export const NODE_ID_PREFIX = 'n';
export const HOTSPOT_ID_PREFIX = 'hs';
export const VARIANT_ID_PREFIX = 'variant';

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectIds(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectIds(item, out));
  } else if (isRec(value)) {
    if (typeof value.id === 'string') out.add(value.id);
    if (typeof value.question_id === 'string') out.add(value.question_id);
    for (const item of Object.values(value)) collectIds(item, out);
  }
}

/** Every `id` and question key anywhere in a unit (sections, questions, nodes, hotspots, variants). */
export function allIdsIn(unit: unknown): Set<string> {
  const out = new Set<string>();
  if (isRec(unit) && isRec(unit.questions)) {
    for (const key of Object.keys(unit.questions)) out.add(key);
  }
  collectIds(unit, out);
  return out;
}
