// Answer-spec builders. The answer of a question is edited through these functions, never as raw data, so the
// shapes that depend on each other stay consistent by construction: remove an option and the "correct" pointer
// follows, rename a sort item and its mapping moves with it, type a third blank in a prompt and the answer grows a
// third blank. What they cannot do (a text must still be filled in, a numeric blank needs a number) the schema and
// lint report next to the field. Every function takes a question and returns a new one.
import { BLANK_PATTERN, countBlanks, normalizeText, type Question } from '@custar/content-schema';
import { nextFreeId, HOTSPOT_ID_PREFIX } from './ids';

type Q<K extends Question['kind']> = Extract<Question, { kind: K }>;

export const MCQ_MIN_OPTIONS = 2;
export const MCQ_MAX_OPTIONS = 6;
export const CIRCLE_MIN_OPTIONS = 2;
export const CIRCLE_MAX_OPTIONS = 12;

// --- multiple choice ---------------------------------------------------------------------------------------------

export function mcqSetOption(question: Q<'mcq'>, index: number, text: string): Q<'mcq'> {
  if (index < 0 || index >= question.options.length) return question;
  return { ...question, options: question.options.map((o, i) => (i === index ? text : o)) };
}

export function mcqAddOption(question: Q<'mcq'>): Q<'mcq'> {
  if (question.options.length >= MCQ_MAX_OPTIONS) return question;
  return { ...question, options: [...question.options, ''] };
}

/** Removes an option; the correct index follows its option (or falls back to the first when the correct one goes). */
export function mcqRemoveOption(question: Q<'mcq'>, index: number): Q<'mcq'> {
  if (question.options.length <= MCQ_MIN_OPTIONS || index < 0 || index >= question.options.length) {
    return question;
  }
  const correct = question.answer.correct_index;
  const next = correct === index ? 0 : correct > index ? correct - 1 : correct;
  return {
    ...question,
    options: question.options.filter((_, i) => i !== index),
    answer: { correct_index: next },
  };
}

export function mcqSetCorrect(question: Q<'mcq'>, index: number): Q<'mcq'> {
  if (index < 0 || index >= question.options.length) return question;
  return { ...question, answer: { correct_index: index } };
}

export function mcqMoveOption(question: Q<'mcq'>, from: number, to: number): Q<'mcq'> {
  const count = question.options.length;
  if (from < 0 || from >= count || to < 0 || to >= count || from === to) return question;
  const options = question.options.slice();
  const [moved] = options.splice(from, 1);
  options.splice(to, 0, moved ?? '');
  const correct = question.answer.correct_index;
  let next = correct;
  if (correct === from) next = to;
  else if (from < correct && to >= correct) next = correct - 1;
  else if (from > correct && to <= correct) next = correct + 1;
  return { ...question, options, answer: { correct_index: next } };
}

// --- fill in the blank ---------------------------------------------------------------------------------------------

/** Gives the answer exactly one blank per run of `___` in the prompt: new blanks are empty, extra ones go. */
export function fillSyncBlanks(question: Q<'fill_blank'>): Q<'fill_blank'> {
  const wanted = Math.max(1, countBlanks(question.prompt));
  const blanks = question.answer.blanks;
  if (blanks.length === wanted) return question;
  if (blanks.length > wanted) return { ...question, answer: { blanks: blanks.slice(0, wanted) } };
  const added = Array.from({ length: wanted - blanks.length }, () => ({ accepted: [''] }));
  return { ...question, answer: { blanks: [...blanks, ...added] } };
}

export function fillSetPrompt(question: Q<'fill_blank'>, prompt: string): Q<'fill_blank'> {
  return fillSyncBlanks({ ...question, prompt });
}

/** Where the blanks are in a prompt, for labelling the answer rows ("Blank 2 of 3"). */
export function blankCount(prompt: string): number {
  return (prompt.match(BLANK_PATTERN) ?? []).length;
}

type Blank = Q<'fill_blank'>['answer']['blanks'][number];

export function fillUpdateBlank(
  question: Q<'fill_blank'>,
  index: number,
  patch: (blank: Blank) => Blank,
): Q<'fill_blank'> {
  if (index < 0 || index >= question.answer.blanks.length) return question;
  return {
    ...question,
    answer: { blanks: question.answer.blanks.map((b, i) => (i === index ? patch(b) : b)) },
  };
}

export function fillSetAccepted(blank: Blank, index: number, text: string): Blank {
  return { ...blank, accepted: blank.accepted.map((a, i) => (i === index ? text : a)) };
}

export function fillAddAccepted(blank: Blank): Blank {
  return { ...blank, accepted: [...blank.accepted, ''] };
}

/** At least one accepted answer always remains. */
export function fillRemoveAccepted(blank: Blank, index: number): Blank {
  if (blank.accepted.length <= 1) return blank;
  return { ...blank, accepted: blank.accepted.filter((_, i) => i !== index) };
}

/** A flag that is off is left out of the data (an absent flag means off). */
export function fillSetFlag(blank: Blank, flag: 'numeric' | 'exact', on: boolean): Blank {
  const { [flag]: _old, ...rest } = blank;
  return on ? { ...rest, [flag]: true } : rest;
}

/** Units are only meaningful for a numeric blank; an empty list is left out. */
export function fillSetUnits(blank: Blank, units: string[]): Blank {
  const { units: _old, ...rest } = blank;
  const clean = units.map((u) => u.trim()).filter((u) => u !== '');
  return clean.length > 0 ? { ...rest, units: clean } : rest;
}

// --- match -----------------------------------------------------------------------------------------------------------

export const MATCH_MIN_PAIRS = 2;

export function matchSetPair(
  question: Q<'match'>,
  index: number,
  side: 'left' | 'right',
  text: string,
): Q<'match'> {
  return {
    ...question,
    answer: {
      pairs: question.answer.pairs.map((p, i) => (i === index ? { ...p, [side]: text } : p)),
    },
  };
}

export function matchAddPair(question: Q<'match'>): Q<'match'> {
  return { ...question, answer: { pairs: [...question.answer.pairs, { left: '', right: '' }] } };
}

export function matchRemovePair(question: Q<'match'>, index: number): Q<'match'> {
  if (question.answer.pairs.length <= MATCH_MIN_PAIRS) return question;
  return { ...question, answer: { pairs: question.answer.pairs.filter((_, i) => i !== index) } };
}

/** The right-hand choices a child sees: every right plus the distractors, in a fixed order. */
export function matchRightChoices(question: Q<'match'>): string[] {
  const rights = question.answer.pairs.map((p) => p.right).filter((r) => r.trim() !== '');
  const distractors = (question.distractors ?? []).filter((d) => d.trim() !== '');
  return [...rights, ...distractors];
}

// --- circle ----------------------------------------------------------------------------------------------------------

function sameText(a: string, b: string): boolean {
  return normalizeText(a) === normalizeText(b);
}

export function circleIsCorrect(question: Q<'circle'>, index: number): boolean {
  const option = question.options[index];
  return option !== undefined && question.answer.correct.some((c) => sameText(c, option));
}

/** Ticks or unticks option `index` as a correct answer. */
export function circleToggleCorrect(question: Q<'circle'>, index: number): Q<'circle'> {
  const option = question.options[index];
  if (option === undefined) return question;
  const correct = circleIsCorrect(question, index)
    ? question.answer.correct.filter((c) => !sameText(c, option))
    : [...question.answer.correct, option];
  return { ...question, answer: { correct } };
}

/** Renames an option; if it was a correct answer the correct list follows. */
export function circleSetOption(question: Q<'circle'>, index: number, text: string): Q<'circle'> {
  const old = question.options[index];
  if (old === undefined) return question;
  const wasCorrect = circleIsCorrect(question, index);
  const options = question.options.map((o, i) => (i === index ? text : o));
  const correct = wasCorrect
    ? question.answer.correct.map((c) => (sameText(c, old) ? text : c))
    : question.answer.correct;
  return { ...question, options, answer: { correct } };
}

export function circleAddOption(question: Q<'circle'>): Q<'circle'> {
  if (question.options.length >= CIRCLE_MAX_OPTIONS) return question;
  return { ...question, options: [...question.options, ''] };
}

export function circleRemoveOption(question: Q<'circle'>, index: number): Q<'circle'> {
  const old = question.options[index];
  if (old === undefined || question.options.length <= CIRCLE_MIN_OPTIONS) return question;
  return {
    ...question,
    options: question.options.filter((_, i) => i !== index),
    answer: { correct: question.answer.correct.filter((c) => !sameText(c, old)) },
  };
}

// --- sort ------------------------------------------------------------------------------------------------------------

export const SORT_MIN = 2;

function mappingEntries(question: Q<'sort'>): [string, string][] {
  return Object.entries(question.answer.mapping);
}

/** The category index an item is sorted into, or -1 when it has none (yet). */
export function sortCategoryIndex(question: Q<'sort'>, itemIndex: number): number {
  const item = question.items[itemIndex];
  if (item === undefined) return -1;
  const found = mappingEntries(question).find(([key]) => sameText(key, item));
  if (!found) return -1;
  return question.categories.findIndex((c) => sameText(c, found[1]));
}

export function sortSetCategory(
  question: Q<'sort'>,
  itemIndex: number,
  categoryIndex: number,
): Q<'sort'> {
  const item = question.items[itemIndex];
  if (item === undefined) return question;
  const rest = mappingEntries(question).filter(([key]) => !sameText(key, item));
  const category = question.categories[categoryIndex];
  const entries = category === undefined ? rest : [...rest, [item, category] as [string, string]];
  return { ...question, answer: { mapping: Object.fromEntries(entries) } };
}

export function sortSetItem(question: Q<'sort'>, index: number, text: string): Q<'sort'> {
  const old = question.items[index];
  if (old === undefined) return question;
  const entries = mappingEntries(question).map(([key, value]): [string, string] =>
    sameText(key, old) ? [text, value] : [key, value],
  );
  return {
    ...question,
    items: question.items.map((item, i) => (i === index ? text : item)),
    answer: { mapping: Object.fromEntries(entries) },
  };
}

export function sortSetCategoryName(question: Q<'sort'>, index: number, text: string): Q<'sort'> {
  const old = question.categories[index];
  if (old === undefined) return question;
  const entries = mappingEntries(question).map(([key, value]): [string, string] =>
    sameText(value, old) ? [key, text] : [key, value],
  );
  return {
    ...question,
    categories: question.categories.map((c, i) => (i === index ? text : c)),
    answer: { mapping: Object.fromEntries(entries) },
  };
}

export function sortAddItem(question: Q<'sort'>): Q<'sort'> {
  return { ...question, items: [...question.items, ''] };
}

export function sortAddCategory(question: Q<'sort'>): Q<'sort'> {
  return { ...question, categories: [...question.categories, ''] };
}

export function sortRemoveItem(question: Q<'sort'>, index: number): Q<'sort'> {
  const old = question.items[index];
  if (old === undefined || question.items.length <= SORT_MIN) return question;
  return {
    ...question,
    items: question.items.filter((_, i) => i !== index),
    answer: {
      mapping: Object.fromEntries(mappingEntries(question).filter(([key]) => !sameText(key, old))),
    },
  };
}

export function sortRemoveCategory(question: Q<'sort'>, index: number): Q<'sort'> {
  const old = question.categories[index];
  if (old === undefined || question.categories.length <= SORT_MIN) return question;
  return {
    ...question,
    categories: question.categories.filter((_, i) => i !== index),
    answer: {
      mapping: Object.fromEntries(
        mappingEntries(question).filter(([, value]) => !sameText(value, old)),
      ),
    },
  };
}

// --- tap the picture --------------------------------------------------------------------------------------------------

type Hotspot = Q<'tap_image'>['answer']['hotspots'][number];

const clamp = (value: number, min: number, max: number): number =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
const round3 = (value: number): number => Math.round(value * 1000) / 1000;

/** Sets one part of a hotspot's rectangle, keeping it inside the picture (0 to 1 in both directions). */
export function hotspotSetBox(
  hotspot: Hotspot,
  key: 'x' | 'y' | 'w' | 'h',
  value: number,
): Hotspot {
  const next = { ...hotspot };
  if (key === 'x') next.x = round3(clamp(value, 0, 1 - 0.01));
  if (key === 'y') next.y = round3(clamp(value, 0, 1 - 0.01));
  if (key === 'w') next.w = round3(clamp(value, 0.01, 1));
  if (key === 'h') next.h = round3(clamp(value, 0.01, 1));
  next.w = round3(Math.min(next.w, 1 - next.x));
  next.h = round3(Math.min(next.h, 1 - next.y));
  return next;
}

export function tapAddHotspot(
  question: Q<'tap_image'>,
  taken: ReadonlySet<string>,
): Q<'tap_image'> {
  const inUse = new Set([...taken, ...question.answer.hotspots.map((h) => h.id)]);
  const id = nextFreeId(HOTSPOT_ID_PREFIX, inUse);
  const added: Hotspot = { id, label: '', x: 0.1, y: 0.1, w: 0.3, h: 0.3, correct: false };
  return { ...question, answer: { hotspots: [...question.answer.hotspots, added] } };
}

export function tapRemoveHotspot(question: Q<'tap_image'>, index: number): Q<'tap_image'> {
  if (question.answer.hotspots.length <= 1) return question;
  return {
    ...question,
    answer: { hotspots: question.answer.hotspots.filter((_, i) => i !== index) },
  };
}

export function tapUpdateHotspot(
  question: Q<'tap_image'>,
  index: number,
  patch: (hotspot: Hotspot) => Hotspot,
): Q<'tap_image'> {
  return {
    ...question,
    answer: { hotspots: question.answer.hotspots.map((h, i) => (i === index ? patch(h) : h)) },
  };
}

// --- speak -----------------------------------------------------------------------------------------------------------

export function speakSetMatch(question: Q<'speak'>, match: 'exact' | 'contains'): Q<'speak'> {
  const { match: _old, ...answer } = question.answer;
  return { ...question, answer: match === 'contains' ? { ...answer, match } : answer };
}
