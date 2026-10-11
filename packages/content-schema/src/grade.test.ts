import { describe, expect, it } from 'vitest';
import { gradeBlank, gradeQuestion, hotspotAt } from './grade';
import { numbersMatch, parseNumeric, rationalEquals } from './numeric';
import type { Question } from './question';
import { levenshtein, matchText, normalizeText } from './text';

describe('normalizeText', () => {
  it('lowercases, trims and collapses whitespace', () => {
    expect(normalizeText('  The   KITCHEN \n')).toBe('the kitchen');
  });

  it('ignores trailing punctuation and surrounding quotes', () => {
    for (const input of [
      'Kitchen!',
      'kitchen.',
      'kitchen?!',
      '"kitchen"',
      '“kitchen”.',
      '(kitchen)',
    ]) {
      expect(normalizeText(input)).toBe('kitchen');
    }
  });

  it('straightens curly apostrophes', () => {
    expect(normalizeText('grown-up’s hand')).toBe("grown-up's hand");
  });

  it('uses Unicode NFC so composed and decomposed forms match', () => {
    const acute = String.fromCharCode(0x301);
    const grave = String.fromCharCode(0x300);
    const dotBelow = String.fromCharCode(0x323);
    const decomposedCafe = `cafe${acute}`;
    const composedCafe = `caf${String.fromCharCode(0xe9)}`;
    expect(decomposedCafe).not.toBe(composedCafe);
    expect(normalizeText(decomposedCafe)).toBe(normalizeText(composedCafe));
    // Yoruba "oko" with dot below and grave: decomposed (o + dot below + grave) vs composed (U+1ECD + grave)
    const decomposed = `o${dotBelow}${grave}ko${dotBelow}${grave}`;
    const composed = `${String.fromCharCode(0x1ecd)}${grave}k${String.fromCharCode(0x1ecd)}${grave}`;
    expect(decomposed).not.toBe(composed);
    expect(normalizeText(decomposed)).toBe(normalizeText(composed));
    expect(normalizeText(decomposed)).toBe(composed);
  });

  it('keeps diacritics: different Yoruba words stay different', () => {
    const dotBelow = String.fromCharCode(0x323);
    const vehicle = `o${dotBelow}ko${dotBelow}`; // "oko" with dots below: vehicle
    expect(normalizeText(vehicle)).not.toBe(normalizeText('oko'));
    expect(normalizeText(`e${String.fromCharCode(0x300)}`)).not.toBe(normalizeText('e'));
  });
});

describe('levenshtein', () => {
  it('computes edit distance', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('same', 'same')).toBe(0);
    expect(levenshtein('kitchen', 'kitchin')).toBe(1);
  });
});

describe('matchText', () => {
  it('matches exactly after normalisation', () => {
    expect(matchText('  KITCHEN. ', ['kitchen'])).toBe('exact');
    expect(matchText('the kitchen', ['kitchen', 'the kitchen'])).toBe('exact');
    expect(matchText('', ['kitchen'])).toBeNull();
  });

  it('forgives one typo only for answers of 6 or more characters', () => {
    expect(matchText('kitchin', ['kitchen'])).toBe('typo');
    expect(matchText('gardan', ['garden'])).toBe('typo');
    // 5 characters or fewer: no tolerance
    expect(matchText('houze', ['house'])).toBeNull();
    expect(matchText('cot', ['cat'])).toBeNull();
    expect(matchText('bit', ['bin'])).toBeNull();
  });

  it('does not forgive two edits', () => {
    expect(matchText('kitchon!', ['kitchen'])).toBe('typo'); // one substitution
    expect(matchText('kichtne', ['kitchen'])).toBeNull(); // a transposition counts as two edits
    expect(matchText('kitchn', ['kitchen'])).toBe('typo'); // one deletion
    expect(matchText('kitchhhen', ['kitchen'])).toBeNull(); // two insertions
  });

  it('can switch tolerance off', () => {
    expect(matchText('kitchin', ['kitchen'], { typoTolerance: false })).toBeNull();
  });

  it('never applies tolerance to answers containing digits', () => {
    expect(matchText('room 13', ['room 12'])).toBeNull();
    expect(matchText('12', ['21'])).toBeNull();
  });
});

describe('parseNumeric and numbersMatch', () => {
  it('reads integers, decimals and leading zeros', () => {
    expect(parseNumeric('12')).toEqual({ n: 12n, d: 1n });
    expect(parseNumeric('0.5')).toEqual({ n: 1n, d: 2n });
    expect(parseNumeric('.5')).toEqual({ n: 1n, d: 2n });
    expect(parseNumeric('05')).toEqual({ n: 5n, d: 1n });
    expect(parseNumeric('5.')).toEqual({ n: 5n, d: 1n });
  });

  it('treats 1/2, 0.5 and the half sign as the same number', () => {
    expect(numbersMatch('1/2', '0.5')).toBe(true);
    expect(numbersMatch('½', '0.5')).toBe(true);
    expect(numbersMatch('2/4', '1/2')).toBe(true);
    expect(numbersMatch('0.25', '1/4')).toBe(true);
    expect(numbersMatch('1 1/2', '1.5')).toBe(true);
    expect(numbersMatch('1½', '3/2')).toBe(true);
  });

  it('is exact: thirds are not decimals', () => {
    expect(numbersMatch('1/3', '0.333')).toBe(false);
    expect(numbersMatch('0.1', '1/10')).toBe(true);
  });

  it('NEVER matches digits that merely look alike', () => {
    expect(numbersMatch('12', '21')).toBe(false);
    expect(numbersMatch('10', '100')).toBe(false);
    expect(numbersMatch('101', '100')).toBe(false);
    expect(numbersMatch('15', '16')).toBe(false);
  });

  it('accepts thousands separators', () => {
    expect(numbersMatch('1,000', '1000')).toBe(true);
    expect(numbersMatch('1 000', '1000')).toBe(true);
    expect(numbersMatch('1,234.50', '1234.5')).toBe(true);
    expect(parseNumeric('1,00')).toBeNull();
    expect(parseNumeric('12,34')).toBeNull();
  });

  it('rejects things that are not numbers', () => {
    for (const input of ['', 'abc', '12abc', '1e3', '1/0', '1/2/3', '0,5', '--3', '.', '1.2.3']) {
      expect(parseNumeric(input)).toBeNull();
    }
    expect(numbersMatch('five', '5')).toBe(false);
  });

  it('handles signs', () => {
    expect(parseNumeric('-3')).toEqual({ n: -3n, d: 1n });
    expect(parseNumeric('−3')).toEqual({ n: -3n, d: 1n });
    expect(numbersMatch('+3', '3')).toBe(true);
  });

  it('strips listed units only', () => {
    const units = ['₦', 'naira'];
    expect(numbersMatch('₦5', '5', { units })).toBe(true);
    expect(numbersMatch('5 naira', '5', { units })).toBe(true);
    expect(numbersMatch('5 Naira.', '5', { units })).toBe(true);
    expect(parseNumeric('₦5')).toBeNull();
    expect(parseNumeric('5 kg', { units })).toBeNull();
  });

  it('compares rationals by value', () => {
    const a = parseNumeric('6/8');
    const b = parseNumeric('0.75');
    expect(a && b && rationalEquals(a, b)).toBe(true);
  });
});

describe('gradeBlank', () => {
  it('uses numeric comparison when asked, with no edit distance', () => {
    const blank = { accepted: ['12'], numeric: true };
    expect(gradeBlank('12', blank)).toBe(true);
    expect(gradeBlank('21', blank)).toBe(false);
    expect(gradeBlank('120', blank)).toBe(false);
    expect(gradeBlank('1', blank)).toBe(false);
    expect(gradeBlank('', blank)).toBe(false);
  });

  it('accepts fraction and decimal equivalents', () => {
    const blank = { accepted: ['1/2', '0.5', 'half'], numeric: true };
    expect(gradeBlank('1/2', blank)).toBe(true);
    expect(gradeBlank('0.5', blank)).toBe(true);
    expect(gradeBlank('½', blank)).toBe(true);
    expect(gradeBlank('2/4', blank)).toBe(true);
    expect(gradeBlank('Half', blank)).toBe(true);
    expect(gradeBlank('halve', blank)).toBe(false);
    expect(gradeBlank('1/3', blank)).toBe(false);
  });

  it('never forgives a typo in a numeric blank, even for a numeric-word accepted value', () => {
    const blank = { accepted: ['seventeen', '17'], numeric: true };
    expect(gradeBlank('seventeen', blank)).toBe(true);
    expect(gradeBlank('seventeeen', blank)).toBe(false);
    expect(gradeBlank('18', blank)).toBe(false);
  });

  it('compares text after normalisation, with optional tolerance', () => {
    const blank = { accepted: ['kitchen', 'the kitchen'] };
    expect(gradeBlank('Kitchen.', blank)).toBe(true);
    expect(gradeBlank('kitchin', blank)).toBe(true);
    expect(gradeBlank('kitchin', blank, { typoTolerance: false })).toBe(false);
    expect(gradeBlank('kitchin', { ...blank, exact: true })).toBe(false);
    expect(gradeBlank('bedroom', blank)).toBe(false);
  });
});

const base = { tier: 1 as const, prompt: 'Prompt' };

const mcq: Question = {
  ...base,
  id: 'q_mcq',
  kind: 'mcq',
  options: ['a', 'b', 'c'],
  answer: { correct_index: 1 },
};

const fill: Question = {
  ...base,
  id: 'q_fill',
  kind: 'fill_blank',
  prompt: 'In my home there is a ____ and a ____.',
  answer: {
    blanks: [{ accepted: ['kitchen'] }, { accepted: ['bedroom'] }],
  },
};

const match: Question = {
  ...base,
  id: 'q_match',
  kind: 'match',
  answer: {
    pairs: [
      { left: 'Kitchen', right: 'Cook' },
      { left: 'Bedroom', right: 'Sleep' },
      { left: 'Classroom', right: 'Learn' },
    ],
  },
};

const circle: Question = {
  ...base,
  id: 'q_circle',
  kind: 'circle',
  options: ['teacher', 'friend', 'classmate', 'astronaut'],
  answer: { correct: ['teacher', 'friend', 'classmate'] },
};

const sort: Question = {
  ...base,
  id: 'q_sort',
  kind: 'sort',
  items: ['classroom', 'kitchen', 'playground', 'bedroom'],
  categories: ['School', 'Home'],
  answer: {
    mapping: { classroom: 'School', kitchen: 'Home', playground: 'School', bedroom: 'Home' },
  },
};

const tap: Question = {
  ...base,
  id: 'q_tap',
  kind: 'tap_image',
  brief: 'A school yard',
  alt: 'A school yard',
  answer: {
    hotspots: [
      { id: 'hs_swing', label: 'swing', x: 0.1, y: 0.1, w: 0.2, h: 0.2, correct: true },
      { id: 'hs_bin', label: 'bin', x: 0.6, y: 0.6, w: 0.2, h: 0.2, correct: false },
    ],
  },
};

const speak: Question = {
  ...base,
  id: 'q_speak',
  kind: 'speak',
  answer: { expected: ['the classroom'] },
};

describe('gradeQuestion', () => {
  it('grades mcq', () => {
    expect(gradeQuestion(mcq, { kind: 'mcq', selected_index: 1 }).result).toBe('correct');
    expect(gradeQuestion(mcq, { kind: 'mcq', selected_index: 0 }).result).toBe('incorrect');
    expect(gradeQuestion(mcq, { kind: 'mcq', selected_index: 7 }).result).toBe('incorrect');
    expect(gradeQuestion(mcq, { kind: 'mcq', selected_index: -1 }).result).toBe('incorrect');
  });

  it('grades fill_blank per blank with partial credit', () => {
    expect(gradeQuestion(fill, { kind: 'fill_blank', answers: ['Kitchen', 'bedroom.'] })).toEqual({
      result: 'correct',
      detail: { reason: 'all_correct', score: 1, items: [true, true] },
    });
    const partial = gradeQuestion(fill, { kind: 'fill_blank', answers: ['kitchen', 'toilet'] });
    expect(partial.result).toBe('partial');
    expect(partial.detail.items).toEqual([true, false]);
    expect(partial.detail.score).toBe(0.5);
    expect(gradeQuestion(fill, { kind: 'fill_blank', answers: ['x', 'y'] }).result).toBe(
      'incorrect',
    );
    // fewer answers than blanks: the missing blank is wrong
    expect(gradeQuestion(fill, { kind: 'fill_blank', answers: ['kitchen'] }).result).toBe(
      'partial',
    );
  });

  it('keeps 12 and 21 apart in a numeric fill_blank', () => {
    const question: Question = {
      ...base,
      id: 'q_num',
      kind: 'fill_blank',
      prompt: '6 + 6 = ____',
      answer: { blanks: [{ accepted: ['12'], numeric: true }] },
    };
    expect(gradeQuestion(question, { kind: 'fill_blank', answers: ['12'] }).result).toBe('correct');
    expect(gradeQuestion(question, { kind: 'fill_blank', answers: ['21'] }).result).toBe(
      'incorrect',
    );
    expect(gradeQuestion(question, { kind: 'fill_blank', answers: [' 12. '] }).result).toBe(
      'correct',
    );
    expect(gradeQuestion(question, { kind: 'fill_blank', answers: ['012'] }).result).toBe(
      'correct',
    );
  });

  it('grades a numeric answer with units and thousands separators', () => {
    const question: Question = {
      ...base,
      id: 'q_money',
      kind: 'fill_blank',
      prompt: 'Price: ₦____',
      answer: { blanks: [{ accepted: ['1000'], numeric: true, units: ['₦', 'naira'] }] },
    };
    for (const answer of ['1000', '1,000', '₦1,000', '1 000 naira']) {
      expect(gradeQuestion(question, { kind: 'fill_blank', answers: [answer] }).result).toBe(
        'correct',
      );
    }
    expect(gradeQuestion(question, { kind: 'fill_blank', answers: ['100'] }).result).toBe(
      'incorrect',
    );
  });

  it('matches 1/2 with 0.5 in a numeric fill_blank', () => {
    const question: Question = {
      ...base,
      id: 'q_half',
      kind: 'fill_blank',
      prompt: 'Half is ____',
      answer: { blanks: [{ accepted: ['1/2'], numeric: true }] },
    };
    for (const answer of ['1/2', '0.5', '.5', '½', '2/4', '0.50']) {
      expect(gradeQuestion(question, { kind: 'fill_blank', answers: [answer] }).result).toBe(
        'correct',
      );
    }
    expect(gradeQuestion(question, { kind: 'fill_blank', answers: ['1/3'] }).result).toBe(
      'incorrect',
    );
  });

  it('grades match pairs', () => {
    const all = [
      { left: 'kitchen', right: 'cook' },
      { left: 'Bedroom', right: 'SLEEP' },
      { left: 'Classroom', right: 'Learn' },
    ];
    expect(gradeQuestion(match, { kind: 'match', pairs: all }).result).toBe('correct');
    const some = [
      { left: 'Kitchen', right: 'Sleep' },
      { left: 'Bedroom', right: 'Sleep' },
      { left: 'Classroom', right: 'Learn' },
    ];
    const partial = gradeQuestion(match, { kind: 'match', pairs: some });
    expect(partial.result).toBe('partial');
    expect(partial.detail.items).toEqual([false, true, true]);
    expect(gradeQuestion(match, { kind: 'match', pairs: [] }).result).toBe('incorrect');
  });

  it('grades circle by set, in any order', () => {
    expect(
      gradeQuestion(circle, { kind: 'circle', selected: ['classmate', 'Teacher', 'friend'] })
        .result,
    ).toBe('correct');
    expect(gradeQuestion(circle, { kind: 'circle', selected: ['teacher', 'friend'] }).result).toBe(
      'partial',
    );
    expect(
      gradeQuestion(circle, { kind: 'circle', selected: ['teacher', 'friend', 'astronaut'] })
        .result,
    ).toBe('incorrect');
    expect(gradeQuestion(circle, { kind: 'circle', selected: [] }).result).toBe('incorrect');
  });

  it('grades sort', () => {
    const right = { classroom: 'School', kitchen: 'Home', playground: 'School', bedroom: 'Home' };
    expect(gradeQuestion(sort, { kind: 'sort', placements: right }).result).toBe('correct');
    expect(
      gradeQuestion(sort, { kind: 'sort', placements: { ...right, kitchen: 'School' } }).result,
    ).toBe('partial');
    expect(gradeQuestion(sort, { kind: 'sort', placements: {} }).result).toBe('incorrect');
  });

  it('grades tap_image by hotspot id and resolves taps', () => {
    expect(gradeQuestion(tap, { kind: 'tap_image', hotspot_ids: ['hs_swing'] }).result).toBe(
      'correct',
    );
    expect(gradeQuestion(tap, { kind: 'tap_image', hotspot_ids: ['hs_bin'] }).result).toBe(
      'incorrect',
    );
    if (tap.kind !== 'tap_image') throw new Error('fixture');
    expect(hotspotAt(tap, 0.2, 0.2)).toBe('hs_swing');
    expect(hotspotAt(tap, 0.9, 0.9)).toBeUndefined();
  });

  it('grades speak on the transcript', () => {
    expect(gradeQuestion(speak, { kind: 'speak', transcript: 'The classroom.' }).result).toBe(
      'correct',
    );
    expect(gradeQuestion(speak, { kind: 'speak', transcript: 'the clasroom' }).result).toBe(
      'correct',
    );
    expect(gradeQuestion(speak, { kind: 'speak', transcript: 'the kitchen' }).result).toBe(
      'incorrect',
    );
    expect(
      gradeQuestion(speak, { kind: 'speak', transcript: 'we learn in the classroom' }).result,
    ).toBe('incorrect');
    const contains: Question = {
      ...base,
      id: 'q_contains',
      kind: 'speak',
      answer: { expected: ['classroom'], match: 'contains' },
    };
    expect(
      gradeQuestion(contains, { kind: 'speak', transcript: 'We learn in the classroom!' }).result,
    ).toBe('correct');
    expect(gradeQuestion(contains, { kind: 'speak', transcript: 'the classrooms' }).result).toBe(
      'incorrect',
    );
  });

  it('leaves draw, free_text and spoken ungraded', () => {
    const draw: Question = { ...base, id: 'q_draw', kind: 'draw' };
    const free: Question = {
      ...base,
      id: 'q_free',
      kind: 'free_text',
      rubric: { criteria: ['Any sensible answer'] },
    };
    const spoken: Question = {
      ...base,
      id: 'q_spoken',
      kind: 'spoken',
      rubric: { criteria: ['Any sensible answer'] },
    };
    expect(gradeQuestion(draw, { kind: 'draw' }).result).toBe('ungraded');
    expect(gradeQuestion(free, { kind: 'free_text', value: 'x' })).toEqual({
      result: 'ungraded',
      detail: { reason: 'graded_online_only', score: null },
    });
    expect(gradeQuestion(spoken, { kind: 'spoken' }).result).toBe('ungraded');
  });

  it('is ungraded when the response kind does not match the question', () => {
    expect(gradeQuestion(mcq, { kind: 'speak', transcript: 'b' }).detail.reason).toBe(
      'response_kind_mismatch',
    );
  });
});
