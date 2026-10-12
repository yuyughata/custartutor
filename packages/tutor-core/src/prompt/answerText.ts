// Short text renderings of a question, for the tutor's grounding and for the mastery guard.
import { stripInlineMarkup } from '@custar/content-schema';
import type { Question } from '@custar/content-schema';

const MAX_ANSWER_CHARS = 200;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 3).trimEnd()}...` : flat;
}

export function promptText(question: Question, max = 300): string {
  return clip(stripInlineMarkup(question.prompt), max);
}

/** The answer as a short plain sentence fragment, or null when the question has no single right answer. */
export function answerText(question: Question): string | null {
  switch (question.kind) {
    case 'mcq':
      return clip(question.options[question.answer.correct_index] ?? '', MAX_ANSWER_CHARS) || null;
    case 'fill_blank':
      return clip(question.answer.blanks.map((blank) => blank.accepted[0] ?? '').join('; '), MAX_ANSWER_CHARS);
    case 'match':
      return clip(question.answer.pairs.map((pair) => `${pair.left} - ${pair.right}`).join('; '), MAX_ANSWER_CHARS);
    case 'circle':
      return clip(question.answer.correct.join(', '), MAX_ANSWER_CHARS);
    case 'sort':
      return clip(
        Object.entries(question.answer.mapping)
          .map(([item, category]) => `${item}: ${category}`)
          .join('; '),
        MAX_ANSWER_CHARS,
      );
    case 'tap_image':
      return clip(
        question.answer.hotspots
          .filter((hotspot) => hotspot.correct)
          .map((hotspot) => hotspot.label)
          .join(', '),
        MAX_ANSWER_CHARS,
      );
    case 'speak':
      return clip(question.answer.expected[0] ?? '', MAX_ANSWER_CHARS) || null;
    case 'free_text':
    case 'spoken':
      return question.rubric.exemplar ? clip(question.rubric.exemplar, MAX_ANSWER_CHARS) : null;
    case 'draw':
      return null;
  }
}

/** Phrases that belong together in a correct answer (an item and its category; one correct option). */
export function answerGroups(question: Question): string[][] {
  switch (question.kind) {
    case 'mcq':
      return [[question.options[question.answer.correct_index] ?? '']];
    case 'fill_blank':
      return question.answer.blanks.flatMap((blank) => blank.accepted.map((value) => [value]));
    case 'match':
      return question.answer.pairs.map((pair) => [pair.left, pair.right]);
    case 'circle':
      return question.answer.correct.map((value) => [value]);
    case 'sort':
      return Object.entries(question.answer.mapping).map(([item, category]) => [item, category]);
    case 'tap_image':
      return question.answer.hotspots.filter((h) => h.correct).map((h) => [h.label]);
    case 'speak':
      return question.answer.expected.map((value) => [value]);
    default:
      return [];
  }
}
