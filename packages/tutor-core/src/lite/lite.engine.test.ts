import { goldenUnit2 } from '@custar/content-schema/fixtures';
import { questionsOf } from '@custar/content-schema';
import type { TutorScript } from '@custar/content-schema';
import { describe, expect, it } from 'vitest';
import type { TutorLiteState } from '../contract';
import { hintLite, initialLiteState, replyLite, skipLite, startLite } from './engine';
import { matchesAccepted, numberWordToDigits } from './match';

const node = (id: string, say: string, extra: Record<string, unknown> = {}) => ({
  id,
  say,
  on_correct: [] as string[],
  on_incorrect: [] as string[],
  hint: [] as string[],
  ...extra,
});

const script = {
  nodes: [
    node('intro', 'Hello!'),
    node('price', 'How much is one orange?', {
      expect: { accepted: ['2', '₦2', '2 naira'] },
      on_correct: ['Yes!', 'Right!'],
      on_incorrect: ['No 1', 'No 2', 'No 3'],
      hint: ['Hint A', 'Hint B'],
    }),
    node('after', 'Good. Next one.'),
    node('half', 'What is half of one?', {
      expect: { accepted: ['1/2', '0.5'] },
      on_correct: ['Correct'],
      on_incorrect: ['Not quite'],
    }),
  ],
} as unknown as TutorScript;

const options = { questions: {} };
const ctx = { script, ...options };
const persist = (state: TutorLiteState): TutorLiteState =>
  JSON.parse(JSON.stringify(state)) as TutorLiteState;

describe('startLite', () => {
  it('says nodes in order until one waits for a reply', () => {
    const step = startLite(script, options);
    expect(step.lines.map((l) => [l.node_id, l.kind, l.text])).toEqual([
      ['intro', 'say', 'Hello!'],
      ['price', 'say', 'How much is one orange?'],
    ]);
    expect(step).toMatchObject({
      expecting: true,
      graded: null,
      state: { node_id: 'price', attempts: 0, finished: false },
    });
  });
});

describe('replyLite', () => {
  it('a right reply: the correct line, then the next nodes', () => {
    const step = replyLite(startLite(script, options).state, '2 naira', ctx);
    expect(step.graded).toEqual({ correct: true });
    expect(step.lines.map((l) => [l.kind, l.text])).toEqual([
      ['correct', 'Yes!'],
      ['say', 'Good. Next one.'],
      ['say', 'What is half of one?'],
    ]);
    expect(step.state.node_id).toBe('half');
  });

  it('misses: a line each time, the hint on the second, on after the third', () => {
    let step = startLite(script, options);
    step = replyLite(persist(step.state), 'wrong', ctx);
    expect(step.lines.map((l) => [l.kind, l.text])).toEqual([['incorrect', 'No 1']]);
    expect(step).toMatchObject({ expecting: true, graded: { correct: false } });
    step = replyLite(persist(step.state), 'wrong', ctx);
    expect(step.lines.map((l) => [l.kind, l.text])).toEqual([
      ['incorrect', 'No 2'],
      ['hint', 'Hint A'],
    ]);
    expect(step.state).toMatchObject({ attempts: 2, hints_used: 1 });
    step = replyLite(persist(step.state), 'wrong', ctx);
    expect(step.lines.map((l) => [l.kind, l.text])).toEqual([
      ['incorrect', 'No 3'],
      ['say', 'Good. Next one.'],
      ['say', 'What is half of one?'],
    ]);
    expect(step.state).toMatchObject({ node_id: 'half', attempts: 0 });
  });

  it('chooses lines by cursor, never by chance', () => {
    const loop = {
      nodes: [
        node('q', 'Say it.', { expect: { accepted: ['go'] }, on_correct: ['A', 'B'], next: 'q' }),
      ],
    } as unknown as TutorScript;
    const c = { script: loop, questions: {} };
    let step = startLite(loop, c);
    const said: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      step = replyLite(persist(step.state), 'go', c);
      said.push(step.lines[0]?.text ?? '');
    }
    expect(said).toEqual(['A', 'B', 'A', 'B', 'A']);
    expect(step.state.cursors).toEqual({ 'q:correct': 5 });
  });

  it('ignores an empty reply, caps a huge one, and does nothing once finished', () => {
    const start = startLite(script, options);
    const empty = replyLite(start.state, '   ', ctx);
    expect(empty).toMatchObject({ lines: [], expecting: true, graded: null, state: start.state });
    const huge = replyLite(start.state, 'x'.repeat(100_000), ctx);
    expect(huge.graded).toEqual({ correct: false });
    const done: TutorLiteState = { ...initialLiteState(), finished: true };
    expect(replyLite(done, 'anything', ctx)).toMatchObject({
      lines: [],
      expecting: false,
      state: done,
    });
    const lost = replyLite({ ...initialLiteState(), node_id: 'gone' }, 'anything', ctx);
    expect(lost).toMatchObject({ lines: [], expecting: false });
  });

  it('does not change the state it is given', () => {
    const start = startLite(script, options);
    const frozen = JSON.stringify(start.state);
    replyLite(start.state, 'wrong', ctx);
    hintLite(start.state, ctx);
    skipLite(start.state, ctx);
    expect(JSON.stringify(start.state)).toBe(frozen);
  });
});

describe('hintLite and skipLite', () => {
  it('a hint request gives the next hint by cursor, and the question again when there is none', () => {
    const start = startLite(script, options);
    const one = hintLite(start.state, ctx);
    const two = hintLite(one.state, ctx);
    expect(one.lines).toEqual([{ node_id: 'price', text: 'Hint A', kind: 'hint' }]);
    expect(two.lines[0]?.text).toBe('Hint B');
    const atHalf = skipLite(start.state, ctx);
    expect(atHalf.state.node_id).toBe('half');
    expect(hintLite(atHalf.state, ctx).lines).toEqual([
      { node_id: 'half', text: 'What is half of one?', kind: 'say' },
    ]);
  });

  it('skipping moves on without feedback or a grade, and never reveals an answer', () => {
    const step = skipLite(startLite(script, options).state, ctx);
    expect(step.graded).toBeNull();
    expect(step.lines.map((l) => l.kind)).toEqual(['say', 'say']);
  });
});

describe('matching: the rules of fill-in-the-blank', () => {
  it('never matches numbers by look-alike', () => {
    expect(matchesAccepted('12', ['12'])).toBe(true);
    expect(matchesAccepted('21', ['12'])).toBe(false);
    expect(matchesAccepted('120', ['12'])).toBe(false);
    expect(matchesAccepted('100', ['1000'])).toBe(false);
    expect(matchesAccepted('10000', ['1000'])).toBe(false);
    expect(matchesAccepted(' 12. ', ['12'])).toBe(true);
    expect(matchesAccepted('012', ['12'])).toBe(true);
    expect(matchesAccepted('12.0', ['12'])).toBe(true);
    expect(matchesAccepted('-12', ['12'])).toBe(false);
  });

  it('compares by value: 1/2 is 0.5', () => {
    for (const reply of ['1/2', '0.5', '.5', '½', '2/4', ' 1 / 2 '])
      expect(matchesAccepted(reply, ['1/2']), reply).toBe(true);
    for (const reply of ['0.5', '1/2', '½'])
      expect(matchesAccepted(reply, ['0.5']), reply).toBe(true);
    for (const reply of ['0,5', '1/3', '5', '0.55'])
      expect(matchesAccepted(reply, ['1/2', '0.5']), reply).toBe(false);
  });

  it('knows units and number words, and only those', () => {
    expect(matchesAccepted('₦2', ['2'])).toBe(true);
    expect(matchesAccepted('2 naira', ['2'])).toBe(true);
    expect(matchesAccepted('two', ['2'])).toBe(true);
    expect(matchesAccepted('twenty five', ['25'])).toBe(true);
    expect(matchesAccepted('twenty', ['25'])).toBe(false);
    expect(matchesAccepted('2 oranges', ['2'])).toBe(false);
    expect(numberWordToDigits('Twenty-Five')).toBe('25');
    expect(numberWordToDigits('fish')).toBeNull();
  });

  it('forgives one typo only in long words', () => {
    expect(matchesAccepted('clasroom', ['classroom'])).toBe(true);
    expect(matchesAccepted('Classroom!', ['classroom'])).toBe(true);
    expect(matchesAccepted('classroon', ['classroom'])).toBe(true);
    expect(matchesAccepted('cat', ['bat'])).toBe(false);
    expect(matchesAccepted('clasrom', ['classroom'])).toBe(false);
    expect(matchesAccepted('', ['classroom'])).toBe(false);
  });
});

describe('grading with a question of the unit', () => {
  const questions = questionsOf(goldenUnit2);
  const one = (id: string, reply: string) => {
    const s = {
      nodes: [
        node('n', 'Q?', { expect: { question_id: id }, on_correct: ['ok'], on_incorrect: ['no'] }),
        node('end', 'Bye.'),
      ],
    } as unknown as TutorScript;
    const c = { script: s, questions };
    return replyLite(startLite(s, c).state, reply, c);
  };

  it.each([
    ['qf_gutter', 'No', true],
    ['qf_gutter', 'no.', true],
    ['qf_gutter', 'B', true],
    ['qf_gutter', '2', true],
    ['qf_gutter', 'Yes', false],
    ['wb_fill_cook', 'the kitchen', true],
    ['wb_fill_cook', 'bedroom', false],
    ['wb_circle_people', 'teacher, friend and classmate', true],
    ['wb_circle_people', 'teacher, friend', false],
    ['wb_circle_people', 'astronaut', false],
    [
      'wb_match_places',
      'Kitchen - Cook, Bedroom - Sleep, Playground - Play, Classroom - Learn, Bathroom - Bath',
      true,
    ],
    ['wb_match_places', 'Kitchen - Sleep', false],
  ])('%s <- "%s": %s', (id, reply, correct) => {
    expect(one(id, reply).graded).toEqual({ correct });
  });

  it('a drawing or free text is a self-report: no grade, a word of "no" is a miss', () => {
    expect(one('dr_family', 'Mummy')).toMatchObject({
      graded: null,
      lines: [{ kind: 'correct' }, { kind: 'say' }, { kind: 'wrap' }],
    });
    expect(one('dr_family', 'no')).toMatchObject({
      graded: null,
      expecting: true,
      lines: [{ kind: 'incorrect' }],
    });
    expect(one('wb_application', 'done').graded).toBeNull();
  });

  it('a question id that is not in the map falls back to a self-report', () => {
    expect(one('gone_missing', 'anything').graded).toBeNull();
  });
});
