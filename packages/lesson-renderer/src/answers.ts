import type { Question } from '@custar/content-schema';

/** A short, human-readable answer for the workbook's "Answers (for self-check)" list. */
export function answerSummary(question: Question): string | null {
  switch (question.kind) {
    case 'mcq':
      return question.options[question.answer.correct_index] ?? null;
    case 'fill_blank':
      return question.answer.blanks.map((blank) => blank.accepted[0] ?? '').join(' / ');
    case 'match':
      return question.answer.pairs.map((pair) => `${pair.left}–${pair.right}`).join(', ');
    case 'circle':
      return question.answer.correct.join(', ');
    case 'sort':
      return Object.entries(question.answer.mapping)
        .map(([item, category]) => `${item}–${category}`)
        .join(', ');
    case 'tap_image':
      return question.answer.hotspots
        .filter((hotspot) => hotspot.correct)
        .map((hotspot) => hotspot.label)
        .join(', ');
    case 'speak':
      return question.answer.expected[0] ?? null;
    case 'draw':
      return question.self_check?.join('; ') ?? null;
    case 'free_text':
    case 'spoken':
      return question.rubric.exemplar ?? `Any answer that ${question.rubric.criteria.join(', ')}`;
  }
}
