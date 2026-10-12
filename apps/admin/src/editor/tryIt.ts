// "Try it": what the REAL offline grader (content-schema `gradeQuestion`, the same function the learner app and the
// tutor use) would say about an answer typed into the editor. The editor builds the response from what a person
// picks or types; nothing here re-implements marking. Questions the grader cannot mark offline say so.
import {
  gradeQuestion,
  isDeterministic,
  type GradeResult,
  type Question,
  type QuestionResponse,
} from '@custar/content-schema';
import { matchRightChoices } from './answers';

/** What a person has entered in the Try-it box, one shape for all kinds. */
export interface TryInput {
  selectedIndex: number | null;
  answers: string[];
  pairs: Record<string, string>;
  selected: string[];
  placements: Record<string, string>;
  hotspotIds: string[];
  transcript: string;
}

export function emptyTry(): TryInput {
  return {
    selectedIndex: null,
    answers: [],
    pairs: {},
    selected: [],
    placements: {},
    hotspotIds: [],
    transcript: '',
  };
}

export type TryOutcome =
  | { kind: 'graded'; result: GradeResult; headline: string; lines: string[] }
  | { kind: 'ungraded'; headline: string; lines: string[] };

/** Builds the response the app would send for this question from the Try-it input; null if nothing was entered. */
export function responseFor(question: Question, input: TryInput): QuestionResponse | null {
  switch (question.kind) {
    case 'mcq':
      return input.selectedIndex === null ? null : { kind: 'mcq', selected_index: input.selectedIndex };
    case 'fill_blank':
      return {
        kind: 'fill_blank',
        answers: question.answer.blanks.map((_, index) => input.answers[index] ?? ''),
      };
    case 'match':
      return {
        kind: 'match',
        pairs: question.answer.pairs
          .filter((pair) => (input.pairs[pair.left] ?? '') !== '')
          .map((pair) => ({ left: pair.left, right: input.pairs[pair.left] ?? '' })),
      };
    case 'circle':
      return { kind: 'circle', selected: input.selected };
    case 'sort':
      return { kind: 'sort', placements: input.placements };
    case 'tap_image':
      return { kind: 'tap_image', hotspot_ids: input.hotspotIds };
    case 'speak':
      return { kind: 'speak', transcript: input.transcript };
    default:
      return null;
  }
}

const REASONS: Record<string, string> = {
  correct_option: 'That is the correct option.',
  wrong_option: 'That is not the correct option.',
  all_correct: 'Everything is right.',
  some_blanks_wrong: 'Some blanks are wrong.',
  all_blanks_wrong: 'Every blank is wrong.',
  some_pairs_wrong: 'Some pairs are wrong.',
  all_pairs_wrong: 'Every pair is wrong.',
  some_items_wrong: 'Some items are in the wrong group.',
  all_items_wrong: 'Every item is in the wrong group.',
  some_correct_missing: 'Right so far, but something correct is missing.',
  wrong_selection: 'Something chosen is wrong.',
  nothing_selected: 'Nothing correct was chosen.',
  transcript_matches: 'The transcript matches an expected answer.',
  transcript_differs: 'The transcript does not match any expected answer.',
  response_kind_mismatch: 'The answer does not fit this kind of question.',
};

function itemLines(question: Question, result: GradeResult): string[] {
  const items = result.detail.items;
  if (!items) return [];
  switch (question.kind) {
    case 'fill_blank':
      return items.map((ok, i) => `Blank ${i + 1}: ${ok ? 'right' : 'wrong'}`);
    case 'match':
      return items.map((ok, i) => `${question.answer.pairs[i]?.left ?? `Pair ${i + 1}`}: ${ok ? 'right' : 'wrong'}`);
    case 'sort':
      return items.map((ok, i) => `${question.items[i] ?? `Item ${i + 1}`}: ${ok ? 'right' : 'wrong'}`);
    default:
      return [];
  }
}

export function tryIt(question: Question, input: TryInput): TryOutcome {
  if (!isDeterministic(question)) {
    if (question.kind === 'draw') {
      return {
        kind: 'ungraded',
        headline: 'Not marked: the child checks their own drawing.',
        lines: ['A drawing can be ticked off against the self-check list, but it never counts towards mastery.'],
      };
    }
    return {
      kind: 'ungraded',
      headline: 'Not marked offline: Claude or a person reads the answer against the rubric.',
      lines: ['Only questions marked offline can grant mastery, so this one never does.'],
    };
  }
  const response = responseFor(question, input);
  if (response === null) {
    return { kind: 'ungraded', headline: 'Pick or type an answer to see how it would be marked.', lines: [] };
  }
  let result: GradeResult;
  try {
    result = gradeQuestion(question, response);
  } catch {
    return {
      kind: 'ungraded',
      headline: 'This question cannot be marked until its answer is complete.',
      lines: ['Fix the problems shown beside the answer first.'],
    };
  }
  const score = result.detail.score === null ? '' : ` (${Math.round(result.detail.score * 100)}%)`;
  return {
    kind: 'graded',
    result,
    headline: `${result.result.toUpperCase()}${score}`,
    lines: [REASONS[result.detail.reason] ?? result.detail.reason, ...itemLines(question, result)],
  };
}

/** The choices to offer for a match question's right-hand side. */
export function matchChoicesFor(question: Extract<Question, { kind: 'match' }>): string[] {
  return matchRightChoices(question);
}
