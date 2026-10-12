import { describe, expect, it } from 'vitest';
import { Question, answerProblems, type Question as Q } from '@custar/content-schema';
import {
  blankCount,
  circleAddOption,
  circleIsCorrect,
  circleRemoveOption,
  circleSetOption,
  circleToggleCorrect,
  fillAddAccepted,
  fillRemoveAccepted,
  fillSetAccepted,
  fillSetFlag,
  fillSetPrompt,
  fillSetUnits,
  fillSyncBlanks,
  fillUpdateBlank,
  hotspotSetBox,
  matchAddPair,
  matchRemovePair,
  matchRightChoices,
  matchSetPair,
  mcqAddOption,
  mcqMoveOption,
  mcqRemoveOption,
  mcqSetCorrect,
  mcqSetOption,
  sortAddCategory,
  sortAddItem,
  sortCategoryIndex,
  sortRemoveCategory,
  sortRemoveItem,
  sortSetCategory,
  sortSetCategoryName,
  sortSetItem,
  speakSetMatch,
  tapAddHotspot,
  tapRemoveHotspot,
  tapUpdateHotspot,
} from './answers';

type K<T extends Q['kind']> = Extract<Q, { kind: T }>;

const mcq: K<'mcq'> = {
  id: 'q_a',
  kind: 'mcq',
  tier: 1,
  prompt: 'Pick one',
  options: ['red', 'green', 'blue'],
  answer: { correct_index: 1 },
};

/** Whatever the builders do, a sound question stays sound. */
function sound(question: Q): void {
  expect(answerProblems(question as never)).toEqual([]);
  expect(Question.safeParse(question).success).toBe(true);
}

describe('mcq', () => {
  it('keeps the correct pointer on the same option when options move or go', () => {
    const removedBefore = mcqRemoveOption(mcq, 0);
    expect(removedBefore.options).toEqual(['green', 'blue']);
    expect(removedBefore.answer.correct_index).toBe(0);
    sound(removedBefore);

    const removedAfter = mcqRemoveOption(mcq, 2);
    expect(removedAfter.answer.correct_index).toBe(1);
    sound(removedAfter);

    const removedCorrect = mcqRemoveOption(mcq, 1);
    expect(removedCorrect.answer.correct_index).toBe(0);
    sound(removedCorrect);

    const moved = mcqMoveOption(mcq, 1, 0);
    expect(moved.options).toEqual(['green', 'red', 'blue']);
    expect(moved.answer.correct_index).toBe(0);
    expect(mcqMoveOption(mcq, 0, 2).answer.correct_index).toBe(0);
    expect(mcqMoveOption(mcq, 2, 0).answer.correct_index).toBe(2);
    sound(moved);
  });

  it('cannot go below 2 or above 6 options, or point outside them', () => {
    const two = mcqRemoveOption(mcqRemoveOption(mcq, 0), 0);
    expect(two.options).toHaveLength(2);
    expect(mcqRemoveOption(two, 0)).toBe(two);
    let full = mcq;
    for (let i = 0; i < 10; i += 1) full = mcqAddOption(full);
    expect(full.options).toHaveLength(6);
    expect(mcqSetCorrect(mcq, 9)).toBe(mcq);
    expect(mcqSetCorrect(mcq, 2).answer.correct_index).toBe(2);
    expect(mcqSetOption(mcq, 0, 'crimson').options[0]).toBe('crimson');
    expect(mcqSetOption(mcq, 7, 'x')).toBe(mcq);
  });
});

const fill: K<'fill_blank'> = {
  id: 'q_f',
  kind: 'fill_blank',
  tier: 1,
  prompt: 'We cook in the ____.',
  answer: { blanks: [{ accepted: ['kitchen'] }] },
};

describe('fill_blank', () => {
  it('keeps one blank in the answer for every run of underscores in the prompt', () => {
    const two = fillSetPrompt(fill, 'The ____ is in the ____.');
    expect(two.answer.blanks).toHaveLength(2);
    expect(two.answer.blanks[0]?.accepted).toEqual(['kitchen']);
    expect(two.answer.blanks[1]?.accepted).toEqual(['']);
    const back = fillSetPrompt(two, 'Only one ____ now.');
    expect(back.answer.blanks).toHaveLength(1);
    expect(blankCount('a ____ b ______ c __ d')).toBe(2);
    expect(fillSyncBlanks(fill)).toBe(fill);
  });

  it('always keeps at least one blank and one accepted answer', () => {
    expect(fillSetPrompt(fill, 'No blank any more').answer.blanks).toHaveLength(1);
    const blank = fill.answer.blanks[0]!;
    expect(fillRemoveAccepted(blank, 0)).toBe(blank);
    const more = fillAddAccepted(fillSetAccepted(blank, 0, 'the kitchen'));
    expect(more.accepted).toEqual(['the kitchen', '']);
    expect(fillRemoveAccepted(more, 1).accepted).toEqual(['the kitchen']);
  });

  it('leaves a flag that is off out of the data, and empty units too', () => {
    const blank = fill.answer.blanks[0]!;
    const numeric = fillSetFlag(blank, 'numeric', true);
    expect(numeric.numeric).toBe(true);
    expect('numeric' in fillSetFlag(numeric, 'numeric', false)).toBe(false);
    expect(fillSetUnits(numeric, [' naira ', '']).units).toEqual(['naira']);
    expect('units' in fillSetUnits(fillSetUnits(numeric, ['naira']), [])).toBe(false);
    const updated = fillUpdateBlank(fill, 0, (b) => fillSetFlag(b, 'exact', true));
    expect(updated.answer.blanks[0]?.exact).toBe(true);
    expect(fillUpdateBlank(fill, 5, (b) => b)).toBe(fill);
    // A new blank starts empty (and the schema says so until it is filled in); filled in, it is sound.
    const two = fillSetPrompt(fill, 'The ____ is in the ____.');
    expect(Question.safeParse(two).success).toBe(false);
    sound(fillUpdateBlank(two, 1, (b) => fillSetAccepted(b, 0, 'house')));
  });
});

const match: K<'match'> = {
  id: 'q_m',
  kind: 'match',
  tier: 1,
  prompt: 'Match',
  answer: {
    pairs: [
      { left: 'Kitchen', right: 'Cook' },
      { left: 'Bedroom', right: 'Sleep' },
    ],
  },
  distractors: ['Fly'],
};

describe('match', () => {
  it('needs two pairs and offers the rights plus the distractors', () => {
    expect(matchRemovePair(match, 0)).toBe(match);
    const three = matchAddPair(match);
    expect(three.answer.pairs).toHaveLength(3);
    expect(matchRemovePair(three, 2).answer.pairs).toHaveLength(2);
    expect(matchSetPair(match, 0, 'right', 'Bake').answer.pairs[0]?.right).toBe('Bake');
    expect(matchRightChoices(match)).toEqual(['Cook', 'Sleep', 'Fly']);
    sound(match);
  });
});

const circle: K<'circle'> = {
  id: 'q_c',
  kind: 'circle',
  tier: 1,
  prompt: 'Circle',
  options: ['teacher', 'friend', 'astronaut'],
  answer: { correct: ['teacher', 'friend'] },
};

describe('circle', () => {
  it('follows renames and removals so the correct list only ever holds options', () => {
    expect(circleIsCorrect(circle, 0)).toBe(true);
    expect(circleIsCorrect(circle, 2)).toBe(false);
    const ticked = circleToggleCorrect(circle, 2);
    expect(ticked.answer.correct).toEqual(['teacher', 'friend', 'astronaut']);
    expect(circleToggleCorrect(ticked, 2).answer.correct).toEqual(['teacher', 'friend']);
    const renamed = circleSetOption(circle, 0, 'Teacher');
    expect(renamed.answer.correct).toEqual(['Teacher', 'friend']);
    sound(renamed);
    const removed = circleRemoveOption(circle, 1);
    expect(removed.options).toEqual(['teacher', 'astronaut']);
    expect(removed.answer.correct).toEqual(['teacher']);
    sound(removed);
    expect(circleRemoveOption(removed, 0)).toBe(removed);
    let full = circle;
    for (let i = 0; i < 20; i += 1) full = circleAddOption(full);
    expect(full.options).toHaveLength(12);
  });
});

const sort: K<'sort'> = {
  id: 'q_s',
  kind: 'sort',
  tier: 1,
  prompt: 'Sort',
  items: ['rubbish', 'flower'],
  categories: ['bin', 'garden'],
  answer: { mapping: { rubbish: 'bin', flower: 'garden' } },
};

describe('sort', () => {
  it('keeps the mapping in step with the items and categories', () => {
    expect(sortCategoryIndex(sort, 0)).toBe(0);
    expect(sortCategoryIndex(sort, 1)).toBe(1);
    const moved = sortSetCategory(sort, 0, 1);
    expect(moved.answer.mapping.rubbish).toBe('garden');
    expect(Object.keys(moved.answer.mapping)).toHaveLength(2);
    const cleared = sortSetCategory(sort, 0, -1);
    expect('rubbish' in cleared.answer.mapping).toBe(false);

    const renamedItem = sortSetItem(sort, 0, 'paper');
    expect(renamedItem.answer.mapping.paper).toBe('bin');
    expect('rubbish' in renamedItem.answer.mapping).toBe(false);
    sound(renamedItem);

    const renamedCategory = sortSetCategoryName(sort, 0, 'dustbin');
    expect(renamedCategory.answer.mapping.rubbish).toBe('dustbin');
    sound(renamedCategory);
  });

  it('adds blanks, removes with the mapping, and keeps two of each', () => {
    const more = sortAddCategory(sortAddItem(sort));
    expect(more.items).toHaveLength(3);
    expect(more.categories).toHaveLength(3);
    const three = sortSetCategory(sortSetItem(more, 2, 'leaf'), 2, 1);
    expect(sortRemoveItem(three, 2).answer.mapping).toEqual(sort.answer.mapping);
    expect(sortRemoveItem(sort, 0)).toBe(sort);
    const withThird = sortSetCategoryName(sortAddCategory(sort), 2, 'compost');
    const removedCategory = sortRemoveCategory(sortSetCategory(withThird, 0, 2), 2);
    expect('rubbish' in removedCategory.answer.mapping).toBe(false);
    expect(sortRemoveCategory(sort, 0)).toBe(sort);
  });
});

const tap: K<'tap_image'> = {
  id: 'q_t',
  kind: 'tap_image',
  tier: 1,
  prompt: 'Tap the bin',
  brief: 'A street',
  alt: 'A street with a bin',
  answer: { hotspots: [{ id: 'hs_1', label: 'bin', x: 0.1, y: 0.1, w: 0.3, h: 0.3, correct: true }] },
};

describe('tap_image', () => {
  it('keeps every rectangle inside the picture', () => {
    const h = tap.answer.hotspots[0]!;
    expect(hotspotSetBox(h, 'x', 0.9)).toMatchObject({ x: 0.9, w: 0.1 });
    expect(hotspotSetBox(h, 'w', 5)).toMatchObject({ w: 0.9 });
    expect(hotspotSetBox(h, 'x', -4).x).toBe(0);
    expect(hotspotSetBox(h, 'y', 2).y).toBeLessThan(1);
    expect(hotspotSetBox(h, 'h', Number.NaN).h).toBeGreaterThan(0);
    const box = hotspotSetBox(hotspotSetBox(h, 'x', 0.95), 'w', 0.5);
    expect(box.x + box.w).toBeLessThanOrEqual(1);
  });

  it('adds hotspots with fresh ids and always keeps one', () => {
    const two = tapAddHotspot(tap, new Set(['hs_2']));
    expect(two.answer.hotspots.map((x) => x.id)).toEqual(['hs_1', 'hs_3']);
    expect(tapRemoveHotspot(tap, 0)).toBe(tap);
    expect(tapRemoveHotspot(two, 1).answer.hotspots).toHaveLength(1);
    const edited = tapUpdateHotspot(two, 1, (x) => ({ ...x, label: 'tree', correct: true }));
    expect(edited.answer.hotspots[1]?.label).toBe('tree');
    sound(edited);
  });
});

describe('speak', () => {
  it('"exact" is the default and is left out of the data', () => {
    const speak: K<'speak'> = { id: 'q_p', kind: 'speak', tier: 1, prompt: 'Say hello', answer: { expected: ['hello'] } };
    const contains = speakSetMatch(speak, 'contains');
    expect(contains.answer.match).toBe('contains');
    expect('match' in speakSetMatch(contains, 'exact').answer).toBe(false);
  });
});
