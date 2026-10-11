import { z } from 'zod';
import { AssetId, Id, Lang, Text, Tier } from './common';
import { parseNumeric } from './numeric';
import { normalizeText } from './text';

/**
 * Questions. Each deterministic kind carries an `answer` spec that is enough to grade the child's
 * response offline with `gradeQuestion`; the presentation fields (prompt, options, items) sit beside it.
 *
 * Graded offline (deterministic): mcq, fill_blank, match, circle, sort, tap_image, speak
 * Self-check only:               draw
 * Graded online, never offline:  free_text, spoken (rubric for Claude / a human; advisory)
 *
 * Only deterministic grading may grant mastery (CLAUDE.md rule 4).
 */

/** A run of three or more underscores marks a blank in a `fill_blank` prompt. */
export const BLANK_PATTERN = /_{3,}/g;

export function countBlanks(prompt: string): number {
  return (prompt.match(BLANK_PATTERN) ?? []).length;
}

const SkillTag = z.string().regex(/^[a-z][a-z0-9_.-]{1,63}$/, 'must be a lowercase skill tag');

const base = {
  id: Id,
  tier: Tier,
  prompt: Text,
  hint: Text.optional(),
  skill_tag: SkillTag.optional(),
  explanation: Text.optional(),
  lang: Lang.optional(),
};

const McqShape = z.object({
  ...base,
  kind: z.literal('mcq'),
  options: z.array(Text).min(2).max(6),
  answer: z.object({ correct_index: z.number().int().min(0) }),
});

const FillBlankShape = z.object({
  ...base,
  kind: z.literal('fill_blank'),
  answer: z.object({
    blanks: z
      .array(
        z.object({
          /** Every acceptable answer for this blank. */
          accepted: z.array(Text).min(1),
          /** Compare by numeric value ("1/2" equals "0.5") instead of by text. Never fuzzy. */
          numeric: z.boolean().optional(),
          /** Unit words or symbols a child may add around a numeric answer, for example ["naira", "₦"]. */
          units: z.array(Text).optional(),
          /** Disable the one-typo tolerance for this blank (when spelling is the objective). */
          exact: z.boolean().optional(),
        }),
      )
      .min(1),
  }),
});

const MatchShape = z.object({
  ...base,
  kind: z.literal('match'),
  /** Extra right-hand items that match nothing. */
  distractors: z.array(Text).optional(),
  answer: z.object({
    pairs: z.array(z.object({ left: Text, right: Text })).min(2),
  }),
});

const CircleShape = z.object({
  ...base,
  kind: z.literal('circle'),
  options: z.array(Text).min(2).max(12),
  answer: z.object({ correct: z.array(Text).min(1) }),
});

const SortShape = z.object({
  ...base,
  kind: z.literal('sort'),
  items: z.array(Text).min(2),
  categories: z.array(Text).min(2),
  answer: z.object({
    /** item text -> category text */
    mapping: z.record(z.string(), z.string()),
  }),
});

export const Hotspot = z.object({
  id: Id,
  label: Text,
  /** Normalised rectangle (0 to 1 of the image width and height). */
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().gt(0).max(1),
  h: z.number().gt(0).max(1),
  correct: z.boolean(),
});
export type Hotspot = z.infer<typeof Hotspot>;

const TapImageShape = z.object({
  ...base,
  kind: z.literal('tap_image'),
  asset_id: AssetId.optional(),
  /** Description of the picture for illustrators; required when there is no `asset_id` yet. */
  brief: Text.optional(),
  alt: Text,
  answer: z.object({ hotspots: z.array(Hotspot).min(1) }),
});

const SpeakShape = z.object({
  ...base,
  kind: z.literal('speak'),
  answer: z.object({
    /** Acceptable transcripts of what the child says. */
    expected: z.array(Text).min(1),
    /** `exact` (default) compares the whole transcript; `contains` accepts the phrase inside a longer reply. */
    match: z.enum(['exact', 'contains']).optional(),
  }),
});

const DrawShape = z.object({
  ...base,
  kind: z.literal('draw'),
  /** Things the child ticks off to check their own drawing. */
  self_check: z.array(Text).optional(),
});

export const Rubric = z.object({
  criteria: z.array(Text).min(1),
  exemplar: Text.optional(),
});
export type Rubric = z.infer<typeof Rubric>;

const FreeTextShape = z.object({
  ...base,
  kind: z.literal('free_text'),
  rubric: Rubric,
});

const SpokenShape = z.object({
  ...base,
  kind: z.literal('spoken'),
  rubric: Rubric,
});

type QuestionShape =
  | z.infer<typeof McqShape>
  | z.infer<typeof FillBlankShape>
  | z.infer<typeof MatchShape>
  | z.infer<typeof CircleShape>
  | z.infer<typeof SortShape>
  | z.infer<typeof TapImageShape>
  | z.infer<typeof SpeakShape>
  | z.infer<typeof DrawShape>
  | z.infer<typeof FreeTextShape>
  | z.infer<typeof SpokenShape>;

export interface AnswerProblem {
  path: (string | number)[];
  message: string;
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const value of values) {
    const key = normalizeText(value);
    if (seen.has(key)) dupes.push(value);
    seen.add(key);
  }
  return dupes;
}

/**
 * Semantic checks on a question's answer spec that a plain shape check cannot express (answer in range,
 * blank count matches the prompt, mapping covers every item, and so on). Returns an empty list when the
 * spec is sound. Used by the Zod schema and by `lintUnit`.
 */
export function answerProblems(question: QuestionShape): AnswerProblem[] {
  const problems: AnswerProblem[] = [];
  const add = (path: (string | number)[], message: string) => problems.push({ path, message });

  switch (question.kind) {
    case 'mcq': {
      if (question.answer.correct_index >= question.options.length) {
        add(['answer', 'correct_index'], 'correct_index is outside the options');
      }
      if (duplicates(question.options).length > 0) add(['options'], 'options must be distinct');
      break;
    }
    case 'fill_blank': {
      const blanks = countBlanks(question.prompt);
      if (blanks !== question.answer.blanks.length) {
        add(
          ['answer', 'blanks'],
          `prompt has ${blanks} blank(s) (____) but the answer defines ${question.answer.blanks.length}`,
        );
      }
      question.answer.blanks.forEach((blank, index) => {
        if (
          blank.numeric &&
          !blank.accepted.some((value) => parseNumeric(value, { units: blank.units }) !== null)
        ) {
          add(['answer', 'blanks', index, 'accepted'], 'numeric blank has no numeric accepted value');
        }
      });
      break;
    }
    case 'match': {
      const lefts = question.answer.pairs.map((pair) => pair.left);
      if (duplicates(lefts).length > 0) add(['answer', 'pairs'], 'left items must be distinct');
      break;
    }
    case 'circle': {
      const options = question.options.map(normalizeText);
      if (duplicates(question.options).length > 0) add(['options'], 'options must be distinct');
      question.answer.correct.forEach((value, index) => {
        if (!options.includes(normalizeText(value))) {
          add(['answer', 'correct', index], 'correct answer is not one of the options');
        }
      });
      if (duplicates(question.answer.correct).length > 0) {
        add(['answer', 'correct'], 'correct answers must be distinct');
      }
      break;
    }
    case 'sort': {
      if (duplicates(question.items).length > 0) add(['items'], 'items must be distinct');
      if (duplicates(question.categories).length > 0) add(['categories'], 'categories must be distinct');
      const categories = question.categories.map(normalizeText);
      const mapping = new Map(
        Object.entries(question.answer.mapping).map(([item, category]) => [
          normalizeText(item),
          category,
        ]),
      );
      for (const item of question.items) {
        const category = mapping.get(normalizeText(item));
        if (category === undefined) {
          add(['answer', 'mapping'], `item "${item}" has no category in the mapping`);
        } else if (!categories.includes(normalizeText(category))) {
          add(['answer', 'mapping'], `item "${item}" maps to "${category}", which is not a category`);
        }
      }
      const items = question.items.map(normalizeText);
      for (const key of mapping.keys()) {
        if (!items.includes(key)) add(['answer', 'mapping'], `mapping key "${key}" is not an item`);
      }
      break;
    }
    case 'tap_image': {
      if (question.asset_id === undefined && question.brief === undefined) {
        add([], 'tap_image needs an asset_id or a brief');
      }
      const ids = question.answer.hotspots.map((hotspot) => hotspot.id);
      if (new Set(ids).size !== ids.length) add(['answer', 'hotspots'], 'hotspot ids must be unique');
      if (!question.answer.hotspots.some((hotspot) => hotspot.correct)) {
        add(['answer', 'hotspots'], 'at least one hotspot must be correct');
      }
      question.answer.hotspots.forEach((hotspot, index) => {
        if (hotspot.x + hotspot.w > 1.0001 || hotspot.y + hotspot.h > 1.0001) {
          add(['answer', 'hotspots', index], 'hotspot extends beyond the image');
        }
      });
      break;
    }
    default:
      break;
  }
  return problems;
}

function withAnswerChecks<T extends z.ZodType<QuestionShape>>(schema: T) {
  return schema.superRefine((question, ctx) => {
    for (const problem of answerProblems(question)) {
      ctx.addIssue({ code: 'custom', message: problem.message, path: problem.path });
    }
  });
}

export const McqQuestion = withAnswerChecks(McqShape);
export const FillBlankQuestion = withAnswerChecks(FillBlankShape);
export const MatchQuestion = withAnswerChecks(MatchShape);
export const CircleQuestion = withAnswerChecks(CircleShape);
export const SortQuestion = withAnswerChecks(SortShape);
export const TapImageQuestion = withAnswerChecks(TapImageShape);
export const SpeakQuestion = withAnswerChecks(SpeakShape);
export const DrawQuestion = DrawShape;
export const FreeTextQuestion = FreeTextShape;
export const SpokenQuestion = SpokenShape;

export const Question = z.discriminatedUnion('kind', [
  McqQuestion,
  FillBlankQuestion,
  MatchQuestion,
  CircleQuestion,
  SortQuestion,
  TapImageQuestion,
  SpeakQuestion,
  DrawQuestion,
  FreeTextQuestion,
  SpokenQuestion,
]);
export type Question = z.infer<typeof Question>;
export type QuestionKind = Question['kind'];

export const QUESTION_KINDS: readonly QuestionKind[] = [
  'mcq',
  'fill_blank',
  'match',
  'circle',
  'sort',
  'tap_image',
  'speak',
  'draw',
  'free_text',
  'spoken',
];

/** Kinds that can be graded offline by `gradeQuestion`. */
export const DETERMINISTIC_KINDS = [
  'mcq',
  'fill_blank',
  'match',
  'circle',
  'sort',
  'tap_image',
  'speak',
] as const satisfies readonly QuestionKind[];
export type DeterministicKind = (typeof DETERMINISTIC_KINDS)[number];

export function isDeterministicKind(kind: string): kind is DeterministicKind {
  return (DETERMINISTIC_KINDS as readonly string[]).includes(kind);
}

export type DeterministicQuestion = Extract<Question, { kind: DeterministicKind }>;

export function isDeterministic(question: Question): question is DeterministicQuestion {
  return isDeterministicKind(question.kind);
}
