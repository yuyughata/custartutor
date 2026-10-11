import { describe, expect, it } from 'vitest';
import {
  DETERMINISTIC_KINDS,
  QUESTION_KINDS,
  Question,
  answerProblems,
  countBlanks,
  isDeterministic,
} from './question';

const common = { tier: 1, prompt: 'Prompt' };

const valid: Record<string, unknown> = {
  mcq: { ...common, id: 'q_mcq', kind: 'mcq', options: ['a', 'b'], answer: { correct_index: 0 } },
  fill_blank: {
    ...common,
    id: 'q_fill',
    kind: 'fill_blank',
    prompt: 'We cook in the ____.',
    answer: { blanks: [{ accepted: ['kitchen'] }] },
  },
  match: {
    ...common,
    id: 'q_match',
    kind: 'match',
    answer: {
      pairs: [
        { left: 'Kitchen', right: 'Cook' },
        { left: 'Bedroom', right: 'Sleep' },
      ],
    },
  },
  circle: {
    ...common,
    id: 'q_circle',
    kind: 'circle',
    options: ['a', 'b', 'c'],
    answer: { correct: ['a', 'c'] },
  },
  sort: {
    ...common,
    id: 'q_sort',
    kind: 'sort',
    items: ['classroom', 'kitchen'],
    categories: ['School', 'Home'],
    answer: { mapping: { classroom: 'School', kitchen: 'Home' } },
  },
  tap_image: {
    ...common,
    id: 'q_tap',
    kind: 'tap_image',
    brief: 'A school yard',
    alt: 'A school yard',
    answer: {
      hotspots: [{ id: 'hs_swing', label: 'swing', x: 0.1, y: 0.1, w: 0.2, h: 0.2, correct: true }],
    },
  },
  speak: { ...common, id: 'q_speak', kind: 'speak', answer: { expected: ['classroom'] } },
  draw: { ...common, id: 'q_draw', kind: 'draw', self_check: ['I drew it'] },
  free_text: {
    ...common,
    id: 'q_free',
    kind: 'free_text',
    rubric: { criteria: ['Any sensible answer'] },
  },
  spoken: {
    ...common,
    id: 'q_spoken',
    kind: 'spoken',
    rubric: { criteria: ['Speaks clearly'], exemplar: 'Example' },
  },
};

function withChanges(kind: string, changes: Record<string, unknown>): unknown {
  return { ...(valid[kind] as object), ...changes };
}

describe('Question', () => {
  it('has a valid example for every kind', () => {
    expect(Object.keys(valid).sort()).toEqual([...QUESTION_KINDS].sort());
    for (const [kind, question] of Object.entries(valid)) {
      expect(Question.parse(question)).toEqual(question);
      expect(Question.parse(question).kind).toBe(kind);
    }
  });

  it('accepts the optional common fields', () => {
    const extra = {
      hint: 'Think about it',
      skill_tag: 'places_and_uses',
      explanation: 'Because.',
      lang: 'en-NG',
    };
    for (const question of Object.values(valid)) {
      const full = { ...(question as object), ...extra };
      expect(Question.parse(full)).toEqual(full);
    }
  });

  it('only free_text, spoken and draw are not deterministic', () => {
    const deterministic = QUESTION_KINDS.filter((kind) =>
      (DETERMINISTIC_KINDS as readonly string[]).includes(kind),
    );
    expect(deterministic).toEqual([
      'mcq',
      'fill_blank',
      'match',
      'circle',
      'sort',
      'tap_image',
      'speak',
    ]);
    for (const [kind, question] of Object.entries(valid)) {
      expect(isDeterministic(Question.parse(question))).toBe(deterministic.includes(kind as never));
    }
  });

  it.each([
    ['an invalid tier', withChanges('mcq', { tier: 4 })],
    ['a bad id', withChanges('mcq', { id: 'Q 1' })],
    ['a blank prompt', withChanges('mcq', { prompt: ' ' })],
    ['an unknown kind', withChanges('mcq', { kind: 'essay' })],
    ['an mcq with one option', withChanges('mcq', { options: ['a'] })],
    [
      'an mcq with the answer outside the options',
      withChanges('mcq', { answer: { correct_index: 2 } }),
    ],
    ['an mcq with duplicate options', withChanges('mcq', { options: ['a', 'A'] })],
    ['an mcq without an answer', withChanges('mcq', { answer: undefined })],
    ['a fill_blank with no blanks defined', withChanges('fill_blank', { answer: { blanks: [] } })],
    [
      'a fill_blank with fewer answer blanks than prompt blanks',
      withChanges('fill_blank', { prompt: 'A ____ and a ____.' }),
    ],
    [
      'a fill_blank with an empty accepted list',
      withChanges('fill_blank', { answer: { blanks: [{ accepted: [] }] } }),
    ],
    [
      'a numeric blank with no numeric accepted value',
      withChanges('fill_blank', { answer: { blanks: [{ accepted: ['kitchen'], numeric: true }] } }),
    ],
    [
      'a match with one pair',
      withChanges('match', { answer: { pairs: [{ left: 'a', right: 'b' }] } }),
    ],
    [
      'a match with duplicate left items',
      withChanges('match', {
        answer: {
          pairs: [
            { left: 'a', right: 'x' },
            { left: 'A', right: 'y' },
          ],
        },
      }),
    ],
    [
      'a circle whose correct answer is not an option',
      withChanges('circle', { answer: { correct: ['z'] } }),
    ],
    ['a circle with nothing correct', withChanges('circle', { answer: { correct: [] } })],
    [
      'a sort with an item missing from the mapping',
      withChanges('sort', { answer: { mapping: { classroom: 'School' } } }),
    ],
    [
      'a sort that maps to a category that does not exist',
      withChanges('sort', { answer: { mapping: { classroom: 'School', kitchen: 'Garden' } } }),
    ],
    [
      'a sort with a mapping key that is not an item',
      withChanges('sort', {
        answer: { mapping: { classroom: 'School', kitchen: 'Home', garage: 'Home' } },
      }),
    ],
    ['a tap_image with neither asset nor brief', withChanges('tap_image', { brief: undefined })],
    [
      'a tap_image with no correct hotspot',
      withChanges('tap_image', {
        answer: {
          hotspots: [{ id: 'hs_a', label: 'a', x: 0, y: 0, w: 0.5, h: 0.5, correct: false }],
        },
      }),
    ],
    [
      'a tap_image with a hotspot outside the picture',
      withChanges('tap_image', {
        answer: {
          hotspots: [{ id: 'hs_a', label: 'a', x: 0.8, y: 0, w: 0.5, h: 0.5, correct: true }],
        },
      }),
    ],
    [
      'a tap_image with duplicate hotspot ids',
      withChanges('tap_image', {
        answer: {
          hotspots: [
            { id: 'hs_a', label: 'a', x: 0, y: 0, w: 0.2, h: 0.2, correct: true },
            { id: 'hs_a', label: 'b', x: 0.5, y: 0.5, w: 0.2, h: 0.2, correct: false },
          ],
        },
      }),
    ],
    ['a speak with nothing expected', withChanges('speak', { answer: { expected: [] } })],
    ['a free_text without a rubric', withChanges('free_text', { rubric: undefined })],
    ['a free_text with an empty rubric', withChanges('free_text', { rubric: { criteria: [] } })],
    ['a spoken without a rubric', withChanges('spoken', { rubric: undefined })],
  ])('rejects %s', (_name, question) => {
    expect(Question.safeParse(question).success).toBe(false);
  });

  it('accepts a tap_image that has an asset id instead of a brief', () => {
    const question = withChanges('tap_image', { brief: undefined, asset_id: 'img_yard_01' });
    expect(Question.safeParse(question).success).toBe(true);
  });

  it('accepts a numeric blank with extra non-numeric words', () => {
    const question = withChanges('fill_blank', {
      answer: { blanks: [{ accepted: ['half', '1/2'], numeric: true }] },
    });
    expect(Question.safeParse(question).success).toBe(true);
  });

  it('accepts match distractors', () => {
    const question = withChanges('match', { distractors: ['Garage'] });
    expect(Question.safeParse(question).success).toBe(true);
  });
});

describe('countBlanks and answerProblems', () => {
  it('counts runs of three or more underscores', () => {
    expect(countBlanks('We cook in the ____.')).toBe(1);
    expect(countBlanks('We cook in the ______.')).toBe(1);
    expect(countBlanks('A ___ and a ____.')).toBe(2);
    expect(countBlanks('snake_case__ and a_b')).toBe(0);
    expect(countBlanks('No blanks.')).toBe(0);
  });

  it('reports problems with paths, for use by lint', () => {
    const question = Question.parse(valid.mcq);
    if (question.kind !== 'mcq') throw new Error('fixture');
    const broken = { ...question, answer: { correct_index: 5 } };
    expect(answerProblems(broken)).toEqual([
      { path: ['answer', 'correct_index'], message: 'correct_index is outside the options' },
    ]);
    expect(answerProblems(question)).toEqual([]);
  });
});
