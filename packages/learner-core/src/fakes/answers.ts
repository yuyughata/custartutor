import type { Question, QuestionResponse } from '@custar/content-schema';

/**
 * Builds the response that `gradeQuestion` marks fully correct for a question (demo mode and tests: "play"
 * a lesson without a human). Open-ended kinds get an empty response of their own kind.
 */
export function correctResponse(question: Question): QuestionResponse {
  switch (question.kind) {
    case 'mcq':
      return { kind: 'mcq', selected_index: question.answer.correct_index };
    case 'fill_blank':
      return {
        kind: 'fill_blank',
        answers: question.answer.blanks.map((blank) => blank.accepted[0] ?? ''),
      };
    case 'match':
      return { kind: 'match', pairs: question.answer.pairs.map((p) => ({ ...p })) };
    case 'circle':
      return { kind: 'circle', selected: [...question.answer.correct] };
    case 'sort':
      return { kind: 'sort', placements: { ...question.answer.mapping } };
    case 'tap_image':
      return {
        kind: 'tap_image',
        hotspot_ids: question.answer.hotspots.filter((h) => h.correct).map((h) => h.id),
      };
    case 'speak':
      return { kind: 'speak', transcript: question.answer.expected[0] ?? '' };
    case 'draw':
    case 'free_text':
    case 'spoken':
      return { kind: question.kind };
  }
}

/** A response of the right kind that is wrong (scores 0). */
export function wrongResponse(question: Question): QuestionResponse {
  switch (question.kind) {
    case 'mcq':
      return {
        kind: 'mcq',
        selected_index: (question.answer.correct_index + 1) % question.options.length,
      };
    case 'fill_blank':
      return { kind: 'fill_blank', answers: question.answer.blanks.map(() => 'zzzz') };
    case 'match': {
      const rights = question.answer.pairs.map((p) => p.right);
      return {
        kind: 'match',
        pairs: question.answer.pairs.map((p, i) => ({
          left: p.left,
          right: rights[(i + 1) % rights.length] ?? '',
        })),
      };
    }
    case 'circle': {
      const wrong = question.options.filter(
        (option) => !question.answer.correct.some((c) => c === option),
      );
      return { kind: 'circle', selected: wrong.slice(0, 1) };
    }
    case 'sort': {
      const placements: Record<string, string> = {};
      for (const item of question.items) {
        const right = question.answer.mapping[item];
        placements[item] = question.categories.find((c) => c !== right) ?? '';
      }
      return { kind: 'sort', placements };
    }
    case 'tap_image':
      return {
        kind: 'tap_image',
        hotspot_ids: question.answer.hotspots.filter((h) => !h.correct).map((h) => h.id),
      };
    case 'speak':
      return { kind: 'speak', transcript: 'zzzz' };
    case 'draw':
    case 'free_text':
    case 'spoken':
      return { kind: question.kind };
  }
}
