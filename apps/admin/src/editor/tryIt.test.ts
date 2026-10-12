import { describe, expect, it } from 'vitest';
import { goldenUnit2 } from '@custar/content-schema/fixtures';
import { gradeQuestion, type Question } from '@custar/content-schema';
import { emptyTry, responseFor, tryIt, type TryInput } from './tryIt';

const q = (id: string): Question => goldenUnit2.questions[id] as Question;

function input(patch: Partial<TryInput>): TryInput {
  return { ...emptyTry(), ...patch };
}

describe('Try it uses the real grader', () => {
  it('mcq: correct and wrong options', () => {
    const question: Question = {
      id: 'q_pick',
      kind: 'mcq',
      tier: 1,
      prompt: 'Which is safe?',
      options: ['a bin', 'a fire', 'a river'],
      answer: { correct_index: 0 },
    };
    const right = (question as Extract<Question, { kind: 'mcq' }>).answer.correct_index;
    const ok = tryIt(question, input({ selectedIndex: right }));
    expect(ok.kind).toBe('graded');
    if (ok.kind === 'graded') {
      expect(ok.result.result).toBe('correct');
      expect(ok.headline).toContain('CORRECT');
    }
    const wrong = tryIt(question, input({ selectedIndex: right === 0 ? 1 : 0 }));
    expect(wrong.kind === 'graded' && wrong.result.result).toBe('incorrect');
    expect(tryIt(question, emptyTry()).kind).toBe('ungraded');
  });

  it('fill_blank: normalisation and typo tolerance come from content-schema', () => {
    const question = q('wb_fill_cook');
    for (const [answer, expected] of [
      ['kitchen', 'correct'],
      ['  The Kitchen!  ', 'correct'],
      ['kitchenn', 'correct'],
      ['bedroom', 'incorrect'],
    ] as const) {
      const out = tryIt(question, input({ answers: [answer] }));
      expect(out.kind === 'graded' && out.result.result).toBe(expected);
    }
  });

  it('numbers are compared by value, never by edit distance', () => {
    const numeric: Question = {
      id: 'q_n',
      kind: 'fill_blank',
      tier: 1,
      prompt: 'Half of 1 is ____.',
      answer: { blanks: [{ accepted: ['0.5'], numeric: true }] },
    };
    expect(tryIt(numeric, input({ answers: ['1/2'] })).kind === 'graded').toBe(true);
    const out = tryIt(numeric, input({ answers: ['1/2'] }));
    expect(out.kind === 'graded' && out.result.result).toBe('correct');
    const other = tryIt(numeric, input({ answers: ['5'] }));
    expect(other.kind === 'graded' && other.result.result).toBe('incorrect');
  });

  it('match: partial credit and the per-pair lines', () => {
    const question = q('wb_match_places');
    const out = tryIt(
      question,
      input({ pairs: { Kitchen: 'Cook', Bedroom: 'Play', Playground: 'Play', Classroom: 'Learn', Bathroom: 'Bath' } }),
    );
    expect(out.kind === 'graded' && out.result.result).toBe('partial');
    if (out.kind === 'graded') {
      expect(out.lines.some((line) => line.startsWith('Bedroom: wrong'))).toBe(true);
      expect(out.lines.some((line) => line.startsWith('Kitchen: right'))).toBe(true);
    }
  });

  it('circle: a missing correct answer is partial, a wrong one incorrect', () => {
    const question = q('wb_circle_people');
    const partial = tryIt(question, input({ selected: ['teacher'] }));
    expect(partial.kind === 'graded' && partial.result.result).toBe('partial');
    const wrong = tryIt(question, input({ selected: ['teacher', 'astronaut'] }));
    expect(wrong.kind === 'graded' && wrong.result.result).toBe('incorrect');
    const right = tryIt(question, input({ selected: ['teacher', 'friend', 'classmate'] }));
    expect(right.kind === 'graded' && right.result.result).toBe('correct');
  });

  it('the response is exactly what gradeQuestion would get', () => {
    const question = q('wb_circle_people');
    const response = responseFor(question, input({ selected: ['teacher'] }));
    expect(response).toEqual({ kind: 'circle', selected: ['teacher'] });
    expect(gradeQuestion(question, response!).result).toBe('partial');
  });

  it('sort, tap_image and speak', () => {
    const sort: Question = {
      id: 'q_s',
      kind: 'sort',
      tier: 1,
      prompt: 'Sort',
      items: ['rubbish', 'flower'],
      categories: ['bin', 'garden'],
      answer: { mapping: { rubbish: 'bin', flower: 'garden' } },
    };
    const s = tryIt(sort, input({ placements: { rubbish: 'bin', flower: 'bin' } }));
    expect(s.kind === 'graded' && s.result.result).toBe('partial');
    const tap: Question = {
      id: 'q_t',
      kind: 'tap_image',
      tier: 1,
      prompt: 'Tap',
      brief: 'b',
      alt: 'a',
      answer: { hotspots: [{ id: 'hs_1', label: 'bin', x: 0, y: 0, w: 0.5, h: 0.5, correct: true }] },
    };
    const t = tryIt(tap, input({ hotspotIds: ['hs_1'] }));
    expect(t.kind === 'graded' && t.result.result).toBe('correct');
    const speak: Question = {
      id: 'q_p',
      kind: 'speak',
      tier: 1,
      prompt: 'Say',
      answer: { expected: ['good morning'], match: 'contains' },
    };
    const p = tryIt(speak, input({ transcript: 'Well, good morning teacher' }));
    expect(p.kind === 'graded' && p.result.result).toBe('correct');
  });

  it('draw, free_text and spoken are never marked offline, and say why', () => {
    for (const id of ['wb_application', 'wb_neighbour']) {
      const out = tryIt(q(id), emptyTry());
      expect(out.kind).toBe('ungraded');
    }
    expect(tryIt(q('wb_neighbour'), emptyTry()).headline).toContain('rubric');
    expect(tryIt(q('wb_application'), emptyTry()).headline).toContain('own drawing');
  });

  it('a broken question is explained, not thrown', () => {
    const broken = { id: 'x', kind: 'mcq', tier: 1, prompt: 'p', options: ['a', 'b'] } as unknown as Question;
    const out = tryIt(broken, input({ selectedIndex: 0 }));
    expect(out.kind).toBe('ungraded');
  });
});
