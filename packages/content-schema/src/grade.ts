import { parseNumeric, rationalEquals } from './numeric';
import type { DeterministicQuestion, Question } from './question';
import { isDeterministic } from './question';
import { matchText, normalizeText } from './text';

/**
 * Deterministic, offline grading. Pure functions: same input, same output, no network, no randomness.
 *
 * Matching rules (documented in `text.ts` and `numeric.ts`):
 *  - text is compared after NFC, trim, whitespace collapse, lowercase and trailing-punctuation removal;
 *  - numeric blanks compare by exact value ("1/2" = "0.5", "1,000" = "1000") and never by edit distance,
 *    so "12" never matches "21";
 *  - one typo is forgiven only on non-numeric answers of 6+ characters (`typoTolerance` can switch it off).
 *
 * `free_text` and `spoken` are never graded here (`ungraded`); `draw` is a self-check (`ungraded`).
 */

export type GradeOutcome = 'correct' | 'incorrect' | 'partial' | 'ungraded';

export interface GradeDetail {
  /** Short machine-readable reason, for example `all_correct`, `wrong_option`, `some_items_wrong`. */
  reason: string;
  /** Fraction of the answer that is right, 0 to 1; null when the question is not graded here. */
  score: number | null;
  /** Per blank / pair / item result, when the kind has several parts. */
  items?: boolean[];
}

export interface GradeResult {
  result: GradeOutcome;
  detail: GradeDetail;
}

export type QuestionResponse =
  | { kind: 'mcq'; selected_index: number }
  | { kind: 'fill_blank'; answers: string[] }
  | { kind: 'match'; pairs: { left: string; right: string }[] }
  | { kind: 'circle'; selected: string[] }
  | { kind: 'sort'; placements: Record<string, string> }
  | { kind: 'tap_image'; hotspot_ids: string[] }
  | { kind: 'speak'; transcript: string }
  | { kind: 'draw' | 'free_text' | 'spoken'; value?: unknown };

export interface GradeOptions {
  /** Forgive one typo on long non-numeric text answers. Default true. */
  typoTolerance?: boolean;
}

function ungraded(reason: string): GradeResult {
  return { result: 'ungraded', detail: { reason, score: null } };
}

function fromItems(
  items: boolean[],
  allReason: string,
  someReason: string,
  noneReason: string,
): GradeResult {
  const right = items.filter(Boolean).length;
  const score = items.length === 0 ? 0 : right / items.length;
  if (right === items.length && items.length > 0) {
    return { result: 'correct', detail: { reason: allReason, score: 1, items } };
  }
  if (right === 0) {
    return { result: 'incorrect', detail: { reason: noneReason, score: 0, items } };
  }
  return { result: 'partial', detail: { reason: someReason, score, items } };
}

/** Grades one fill-in-the-blank answer against its accepted values. Exported for the tutor scripts. */
export function gradeBlank(
  response: string,
  blank: {
    accepted: readonly string[];
    numeric?: boolean;
    units?: readonly string[];
    exact?: boolean;
  },
  options: GradeOptions = {},
): boolean {
  const typoTolerance = options.typoTolerance !== false && blank.exact !== true;
  if (blank.numeric) {
    const parsed = parseNumeric(response, { units: blank.units });
    if (parsed !== null) {
      return blank.accepted.some((value) => {
        const expected = parseNumeric(value, { units: blank.units });
        return expected !== null && rationalEquals(parsed, expected);
      });
    }
    // Not a number: only an exact match against non-numeric accepted words ("five") counts.
    const words = blank.accepted.filter(
      (value) => parseNumeric(value, { units: blank.units }) === null,
    );
    return matchText(response, words, { typoTolerance: false }) !== null;
  }
  return matchText(response, blank.accepted, { typoTolerance }) !== null;
}

/** True when the response is the same set of strings as `expected` (after normalisation). */
function sameSet(selected: readonly string[], expected: readonly string[]): boolean {
  const a = new Set(selected.map(normalizeText));
  const b = new Set(expected.map(normalizeText));
  return a.size === b.size && [...a].every((value) => b.has(value));
}

function gradeSelection(selected: readonly string[], correct: readonly string[]): GradeResult {
  const chosen = new Set(selected.map(normalizeText).filter((value) => value !== ''));
  const right = new Set(correct.map(normalizeText));
  const hits = [...chosen].filter((value) => right.has(value)).length;
  const wrong = chosen.size - hits;
  if (sameSet([...chosen], [...right])) {
    return { result: 'correct', detail: { reason: 'all_correct', score: 1 } };
  }
  if (hits > 0 && wrong === 0) {
    return {
      result: 'partial',
      detail: { reason: 'some_correct_missing', score: hits / right.size },
    };
  }
  return {
    result: 'incorrect',
    detail: { reason: wrong > 0 ? 'wrong_selection' : 'nothing_selected', score: 0 },
  };
}

function gradeDeterministic(
  question: DeterministicQuestion,
  response: QuestionResponse,
  options: GradeOptions,
): GradeResult {
  if (response.kind !== question.kind) return ungraded('response_kind_mismatch');

  switch (question.kind) {
    case 'mcq': {
      if (response.kind !== 'mcq') return ungraded('response_kind_mismatch');
      const ok = response.selected_index === question.answer.correct_index;
      return ok
        ? { result: 'correct', detail: { reason: 'correct_option', score: 1 } }
        : { result: 'incorrect', detail: { reason: 'wrong_option', score: 0 } };
    }
    case 'fill_blank': {
      if (response.kind !== 'fill_blank') return ungraded('response_kind_mismatch');
      const items = question.answer.blanks.map((blank, index) =>
        gradeBlank(response.answers[index] ?? '', blank, options),
      );
      return fromItems(items, 'all_correct', 'some_blanks_wrong', 'all_blanks_wrong');
    }
    case 'match': {
      if (response.kind !== 'match') return ungraded('response_kind_mismatch');
      const given = new Map(response.pairs.map((pair) => [normalizeText(pair.left), pair.right]));
      const items = question.answer.pairs.map((pair) => {
        const right = given.get(normalizeText(pair.left));
        return right !== undefined && normalizeText(right) === normalizeText(pair.right);
      });
      return fromItems(items, 'all_correct', 'some_pairs_wrong', 'all_pairs_wrong');
    }
    case 'circle': {
      if (response.kind !== 'circle') return ungraded('response_kind_mismatch');
      return gradeSelection(response.selected, question.answer.correct);
    }
    case 'sort': {
      if (response.kind !== 'sort') return ungraded('response_kind_mismatch');
      const given = new Map(
        Object.entries(response.placements).map(([item, category]) => [
          normalizeText(item),
          category,
        ]),
      );
      const expected = new Map(
        Object.entries(question.answer.mapping).map(([item, category]) => [
          normalizeText(item),
          category,
        ]),
      );
      const items = question.items.map((item) => {
        const key = normalizeText(item);
        const placed = given.get(key);
        const category = expected.get(key);
        return (
          placed !== undefined &&
          category !== undefined &&
          normalizeText(placed) === normalizeText(category)
        );
      });
      return fromItems(items, 'all_correct', 'some_items_wrong', 'all_items_wrong');
    }
    case 'tap_image': {
      if (response.kind !== 'tap_image') return ungraded('response_kind_mismatch');
      const correct = question.answer.hotspots.filter((h) => h.correct).map((h) => h.id);
      return gradeSelection(response.hotspot_ids, correct);
    }
    case 'speak': {
      if (response.kind !== 'speak') return ungraded('response_kind_mismatch');
      const { expected, match } = question.answer;
      const ok =
        matchText(response.transcript, expected, { typoTolerance: options.typoTolerance }) !==
          null ||
        (match === 'contains' && containsPhrase(response.transcript, expected));
      return ok
        ? { result: 'correct', detail: { reason: 'transcript_matches', score: 1 } }
        : { result: 'incorrect', detail: { reason: 'transcript_differs', score: 0 } };
    }
  }
}

function containsPhrase(transcript: string, expected: readonly string[]): boolean {
  const spoken = ` ${normalizeText(transcript)
    .replace(/[\p{P}]+/gu, ' ')
    .replace(/\s+/g, ' ')} `;
  return expected.some((phrase) => {
    const needle = normalizeText(phrase)
      .replace(/[\p{P}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return needle !== '' && spoken.includes(` ${needle} `);
  });
}

/**
 * Grades a child's response to a question, offline and deterministically.
 *
 * Returns `ungraded` for `draw`, `free_text` and `spoken` (and when the response kind does not match the
 * question kind). Only a `correct` result from a deterministic kind may count towards mastery.
 */
export function gradeQuestion(
  question: Question,
  response: QuestionResponse,
  options: GradeOptions = {},
): GradeResult {
  if (!isDeterministic(question)) {
    return ungraded(question.kind === 'draw' ? 'self_check_only' : 'graded_online_only');
  }
  return gradeDeterministic(question, response, options);
}

/** Convenience: the tap point resolved to the hotspot under it, or undefined. */
export function hotspotAt(
  question: Extract<Question, { kind: 'tap_image' }>,
  x: number,
  y: number,
): string | undefined {
  return question.answer.hotspots.find(
    (h) => x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h,
  )?.id;
}
