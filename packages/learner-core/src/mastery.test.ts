import { colourChartProject, goldenUnit2 } from '@custar/content-schema/fixtures';
import { parseUnit } from '@custar/content-schema';
import type { QuestionResponse, UnitContent } from '@custar/content-schema';
import { describe, expect, it } from 'vitest';
import { correctResponse, wrongResponse } from './fakes/answers';
import {
  MASTERY_THRESHOLD,
  compareUnitOrder,
  deriveUnitProgress,
  effectiveProgress,
  gradeMasteryCheck,
  masteryQuestionIds,
  unlockStates,
} from './mastery';
import type { ProgressEvent, ServerProgress } from './mastery';
import {
  answeredEvent,
  completedEvent,
  masteryEvent,
  sectionEvent,
  shuffled,
  startedEvent,
  uuidN,
} from './test-helpers';
import type { WireEvent } from './wire';

const unit = parseUnit(goldenUnit2);

function responsesFor(
  content: UnitContent,
  pick: (id: string) => 'right' | 'wrong' | 'skip',
): Record<string, QuestionResponse> {
  const questions = content.kind === 'lesson' ? content.questions : {};
  const out: Record<string, QuestionResponse> = {};
  for (const id of masteryQuestionIds(content)) {
    const question = questions[id];
    const choice = pick(id);
    if (!question || choice === 'skip') continue;
    out[id] = choice === 'right' ? correctResponse(question) : wrongResponse(question);
  }
  return out;
}

describe('MASTERY_THRESHOLD', () => {
  it('is 0.8', () => {
    expect(MASTERY_THRESHOLD).toBe(0.8);
  });
});

describe('gradeMasteryCheck', () => {
  it('finds the mastery questions of the golden unit', () => {
    expect(masteryQuestionIds(unit)).toEqual(['mc_places', 'mc_people', 'mc_safe_clean']);
  });

  it('passes with everything right', () => {
    const outcome = gradeMasteryCheck(unit, responsesFor(unit, () => 'right'));
    expect(outcome).toMatchObject({ score: 1, passed: true, question_count: 3 });
    expect(outcome.items.every((item) => item.result === 'correct')).toBe(true);
  });

  it('fails with everything wrong, or nothing answered', () => {
    expect(gradeMasteryCheck(unit, responsesFor(unit, () => 'wrong'))).toMatchObject({
      score: 0,
      passed: false,
    });
    const skipped = gradeMasteryCheck(unit, {});
    expect(skipped).toMatchObject({ score: 0, passed: false, question_count: 3 });
    expect(skipped.items.every((item) => item.result === 'missing')).toBe(true);
  });

  it('does not pass with one of three wrong (0.6667 < 0.8)', () => {
    const outcome = gradeMasteryCheck(
      unit,
      responsesFor(unit, (id) => (id === 'mc_people' ? 'wrong' : 'right')),
    );
    expect(outcome.score).toBe(0.6667);
    expect(outcome.passed).toBe(false);
  });

  it('counts a partly right answer as its fraction', () => {
    const responses = responsesFor(unit, () => 'right');
    // two of three pairs right on the match question
    responses.mc_people = {
      kind: 'match',
      pairs: [
        { left: 'At home', right: 'family' },
        { left: 'At school', right: 'teachers and friends' },
        { left: 'Near our home', right: 'family' },
      ],
    };
    const outcome = gradeMasteryCheck(unit, responses);
    const people = outcome.items.find((item) => item.question_id === 'mc_people');
    expect(people).toMatchObject({ result: 'partial', score: 0.6667 - 0.0000333333 });
    expect(outcome.score).toBeCloseTo((2 + 2 / 3) / 3, 4);
    expect(outcome.passed).toBe(true); // 0.8889
  });

  it('treats a response of the wrong kind as 0', () => {
    const responses = responsesFor(unit, () => 'right');
    responses.mc_places = { kind: 'mcq', selected_index: 0 };
    const outcome = gradeMasteryCheck(unit, responses);
    expect(outcome.items.find((i) => i.question_id === 'mc_places')?.score).toBe(0);
    expect(outcome.passed).toBe(false);
  });

  function withExtraQuestions(extra: number, openEnded = false): UnitContent {
    const copy = structuredClone(unit);
    if (copy.kind !== 'lesson') throw new Error('expected a lesson');
    const section = copy.sections.find((s) => s.type === 'mastery_check');
    for (let i = 1; i <= extra; i += 1) {
      const id = `mc_extra_${i}`;
      copy.questions[id] = {
        id,
        kind: 'mcq',
        tier: 1,
        prompt: `Extra ${i}?`,
        options: ['a', 'b'],
        answer: { correct_index: 0 },
      };
      section?.blocks.push({ type: 'question', question_id: id });
    }
    if (openEnded) {
      copy.questions.mc_open = {
        id: 'mc_open',
        kind: 'free_text',
        tier: 3,
        prompt: 'Tell me about your home.',
        rubric: { criteria: ['mentions a place'] },
      };
      section?.blocks.push({ type: 'question', question_id: 'mc_open' });
    }
    return copy;
  }

  it('passes at exactly 0.8 (four of five) and not at 0.6', () => {
    const five = withExtraQuestions(2);
    const four = gradeMasteryCheck(
      five,
      responsesFor(five, (id) => (id === 'mc_extra_2' ? 'wrong' : 'right')),
    );
    expect(four).toMatchObject({ score: 0.8, passed: true, question_count: 5 });
    const three = gradeMasteryCheck(
      five,
      responsesFor(five, (id) => (id.startsWith('mc_extra') ? 'wrong' : 'right')),
    );
    expect(three).toMatchObject({ score: 0.6, passed: false });
  });

  it('does not score open-ended questions', () => {
    const withOpen = withExtraQuestions(0, true);
    const responses = responsesFor(withOpen, () => 'right');
    responses.mc_open = { kind: 'free_text', value: 'I live in a big house' };
    const outcome = gradeMasteryCheck(withOpen, responses);
    expect(outcome.question_count).toBe(3);
    expect(outcome.unscored_question_ids).toEqual(['mc_open']);
    expect(outcome.passed).toBe(true);
  });

  it('can never pass a check with nothing gradable', () => {
    const project = parseUnit(colourChartProject);
    expect(gradeMasteryCheck(project, {})).toMatchObject({
      score: 0,
      passed: false,
      question_count: 0,
    });
    const onlyOpen = withExtraQuestions(0, true);
    if (onlyOpen.kind !== 'lesson') throw new Error('lesson');
    for (const section of onlyOpen.sections) {
      if (section.type === 'mastery_check') {
        section.blocks = section.blocks.filter(
          (b) => b.type !== 'question' || b.question_id === 'mc_open',
        );
      }
    }
    expect(gradeMasteryCheck(onlyOpen, {})).toMatchObject({ passed: false, question_count: 0 });
  });

  it('ignores responses to questions outside the mastery check', () => {
    const responses = responsesFor(unit, () => 'wrong');
    responses.qf_gutter = { kind: 'mcq', selected_index: 1 };
    expect(gradeMasteryCheck(unit, responses).score).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------

function randomEvents(seed: number, count: number): ProgressEvent[] {
  let state = seed >>> 0 || 1;
  const rand = (n: number): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return Math.floor((state / 0x100000000) * n);
  };
  const events: WireEvent[] = [];
  for (let i = 0; i < count; i += 1) {
    const occurred_at = new Date(Date.UTC(2026, 9, 12, 8, rand(60), rand(60))).toISOString();
    const base = { client_event_id: uuidN(seed * 1000 + i), occurred_at };
    switch (rand(5)) {
      case 0:
        events.push(startedEvent(base));
        break;
      case 1:
        events.push(sectionEvent(`sec_${rand(6)}`, base));
        break;
      case 2:
        events.push(answeredEvent(`q_${rand(9)}`, rand(2) ? 'correct' : 'incorrect', base));
        break;
      case 3: {
        const score = rand(11) / 10;
        events.push(masteryEvent(score, score >= 0.8, base));
        break;
      }
      default:
        events.push(completedEvent(base));
    }
  }
  return events;
}

describe('deriveUnitProgress', () => {
  it('returns null without events', () => {
    expect(deriveUnitProgress([])).toBeNull();
  });

  it('is in_progress after any event and records the newest section', () => {
    const progress = deriveUnitProgress([
      startedEvent({ occurred_at: '2026-10-12T08:00:00Z' }),
      sectionEvent('intro', { occurred_at: '2026-10-12T08:01:00Z' }),
      sectionEvent('teach', { occurred_at: '2026-10-12T08:05:00Z' }),
      sectionEvent('older', { occurred_at: '2026-10-12T08:03:00Z' }),
    ]);
    expect(progress).toEqual({
      status: 'in_progress',
      mastery_score: null,
      attempts: 0,
      last_section: 'teach',
      updated_at: '2026-10-12T08:05:00Z',
    });
  });

  it('is mastered iff a check passed; attempts count distinct checks; score is the best', () => {
    const failed = masteryEvent(0.5, false);
    const passed = masteryEvent(0.9, true);
    const failedAgain = masteryEvent(0.6, false);
    expect(deriveUnitProgress([failed, failedAgain])).toMatchObject({
      status: 'in_progress',
      attempts: 2,
      mastery_score: 0.6,
    });
    expect(deriveUnitProgress([failed, passed, failedAgain])).toMatchObject({
      status: 'mastered',
      attempts: 3,
      mastery_score: 0.9,
    });
  });

  it('does not let question or unit_completed events grant mastery (CLAUDE.md rule 4)', () => {
    const progress = deriveUnitProgress([
      answeredEvent('q_1', 'correct'),
      answeredEvent('q_2', 'correct'),
      completedEvent(),
    ]);
    expect(progress?.status).toBe('in_progress');
    expect(progress?.attempts).toBe(0);
  });

  it('counts duplicates once', () => {
    const check = masteryEvent(0.7, false);
    expect(deriveUnitProgress([check, check, { ...check }])?.attempts).toBe(1);
  });

  it('breaks timestamp ties by event id, whatever the arrival order', () => {
    const a = sectionEvent('first', { client_event_id: uuidN(1), occurred_at: '2026-10-12T08:00:00Z' });
    const b = sectionEvent('second', { client_event_id: uuidN(2), occurred_at: '2026-10-12T08:00:00Z' });
    expect(deriveUnitProgress([a, b])?.last_section).toBe('second');
    expect(deriveUnitProgress([b, a])?.last_section).toBe('second');
  });

  it('compares timestamps as instants, not as strings', () => {
    const early = sectionEvent('early', { occurred_at: '2026-10-12T09:00:00+02:00' }); // 07:00Z
    const late = sectionEvent('late', { occurred_at: '2026-10-12T08:00:00Z' });
    expect(deriveUnitProgress([early, late])?.last_section).toBe('late');
  });

  describe('property: commutative and idempotent', () => {
    for (let seed = 1; seed <= 25; seed += 1) {
      it(`seed ${seed}: any order, any duplication gives the same result`, () => {
        const events = randomEvents(seed, 6 + (seed % 20));
        const expected = deriveUnitProgress(events);
        for (let round = 0; round < 6; round += 1) {
          const duplicated = [...events, ...events.filter((_, i) => (i + round) % 2 === 0)];
          expect(deriveUnitProgress(shuffled(duplicated, seed * 31 + round))).toEqual(expected);
        }
        // folding in two halves in either order agrees with folding everything
        const half = Math.floor(events.length / 2);
        const left = events.slice(0, half);
        const right = events.slice(half);
        expect(deriveUnitProgress([...left, ...right])).toEqual(deriveUnitProgress([...right, ...left]));
      });

      it(`seed ${seed}: more events never lower the status`, () => {
        const events = shuffled(randomEvents(seed, 14), seed);
        let sawMastered = false;
        for (let n = 1; n <= events.length; n += 1) {
          const status = deriveUnitProgress(events.slice(0, n))?.status;
          if (status === 'mastered') sawMastered = true;
          if (sawMastered) expect(status).toBe('mastered');
        }
      });
    }
  });
});

describe('effectiveProgress', () => {
  const server = (over: Partial<ServerProgress> = {}): ServerProgress => ({
    status: 'in_progress',
    mastery_score: 0.5,
    attempts: 1,
    last_section: 'teach',
    updated_at: '2026-10-12T08:00:00Z',
    ...over,
  });

  it('is null with nothing, and the server row without pending events', () => {
    expect(effectiveProgress(null, [])).toBeNull();
    expect(effectiveProgress(server(), [])).toEqual({ ...server(), has_pending: false });
  });

  it('shows local progress when the server knows nothing yet', () => {
    const result = effectiveProgress(null, [sectionEvent('intro')]);
    expect(result).toMatchObject({ status: 'in_progress', last_section: 'intro', has_pending: true });
  });

  it('shows a pending passing check as mastered right away', () => {
    const result = effectiveProgress(server(), [masteryEvent(0.9, true)]);
    expect(result).toMatchObject({
      status: 'mastered',
      attempts: 2,
      mastery_score: 0.9,
      has_pending: true,
    });
  });

  it('never downgrades a mastered server row', () => {
    const mastered = server({ status: 'mastered', mastery_score: 0.9, attempts: 2 });
    const result = effectiveProgress(mastered, [masteryEvent(0.2, false), sectionEvent('x')]);
    expect(result).toMatchObject({ status: 'mastered', mastery_score: 0.9, attempts: 3 });
  });

  it('keeps the best score and prefers the newest section and time', () => {
    const result = effectiveProgress(server({ mastery_score: 0.7 }), [
      masteryEvent(0.6, false, { occurred_at: '2026-10-12T09:00:00Z' }),
      sectionEvent('later', { occurred_at: '2026-10-12T09:01:00Z' }),
    ]);
    expect(result).toMatchObject({
      mastery_score: 0.7,
      last_section: 'later',
      updated_at: '2026-10-12T09:01:00Z',
    });
  });

  it('treats a server locked/available row as below in_progress', () => {
    const result = effectiveProgress(server({ status: 'available' }), [startedEvent()]);
    expect(result?.status).toBe('in_progress');
  });
});

describe('unlockStates', () => {
  const chain = [
    { id: 'u1', kind: 'lesson' },
    { id: 'u2', kind: 'lesson' },
    { id: 'p1', kind: 'mini_project' },
    { id: 'u3', kind: 'lesson' },
    { id: 'r1', kind: 'revision' },
    { id: 'a1', kind: 'assessment' },
  ];
  const progress = (entries: Record<string, 'in_progress' | 'mastered'>) =>
    new Map(Object.entries(entries).map(([id, status]) => [id, { status }]));

  it('opens only the first unit of a fresh chain', () => {
    const states = unlockStates(chain, new Map());
    expect(states.get('u1')).toBe('available');
    expect(states.get('u2')).toBe('locked');
    expect(states.get('p1')).toBe('locked');
    expect(states.get('u3')).toBe('locked');
  });

  it('opens the next unit when the previous lesson is mastered', () => {
    const states = unlockStates(chain, progress({ u1: 'mastered' }));
    expect(states.get('u1')).toBe('mastered');
    expect(states.get('u2')).toBe('available');
    expect(states.get('p1')).toBe('locked');
  });

  it('does not open the next unit for an in-progress or failed lesson', () => {
    const states = unlockStates(chain, progress({ u1: 'in_progress' }));
    expect(states.get('u1')).toBe('in_progress');
    expect(states.get('u2')).toBe('locked');
  });

  it('lets projects, revision and assessment open behind the previous lesson without gating', () => {
    const states = unlockStates(chain, progress({ u1: 'mastered', u2: 'mastered' }));
    expect(states.get('p1')).toBe('available');
    // the project has no mastery check: the next lesson depends on lesson u2, not on p1
    expect(states.get('u3')).toBe('available');
    expect(states.get('r1')).toBe('locked'); // needs u3
    const later = unlockStates(chain, progress({ u1: 'mastered', u2: 'mastered', u3: 'mastered' }));
    expect(later.get('r1')).toBe('available');
    expect(later.get('a1')).toBe('available');
  });

  it('never takes access away from a unit that has progress', () => {
    const states = unlockStates(chain, progress({ u3: 'in_progress' }));
    expect(states.get('u3')).toBe('in_progress');
    expect(states.get('u2')).toBe('locked');
  });

  it('opens a leading project and handles an empty chain', () => {
    const states = unlockStates([{ id: 'p0', kind: 'term_project' }, { id: 'u1', kind: 'lesson' }], new Map());
    expect(states.get('p0')).toBe('available');
    expect(states.get('u1')).toBe('available');
    expect(unlockStates([], new Map()).size).toBe(0);
  });

  it('ignores server-sent locked/available values', () => {
    const states = unlockStates(chain, new Map([['u2', { status: 'available' as const }]]));
    expect(states.get('u2')).toBe('locked');
  });
});

describe('compareUnitOrder', () => {
  it('orders by level, term, chapter and unit', () => {
    const list = [
      { level_code: 'P1', term: 2, chapter_number: 1, unit_no: 1 },
      { level_code: 'P1', term: 1, chapter_number: 2, unit_no: 1 },
      { level_code: 'P1', term: 1, chapter_number: 1, unit_no: 3 },
      { level_code: 'P1', term: 1, chapter_number: 1, unit_no: 2 },
    ];
    expect([...list].sort(compareUnitOrder).map((u) => [u.term, u.chapter_number, u.unit_no])).toEqual([
      [1, 1, 2],
      [1, 1, 3],
      [1, 2, 1],
      [2, 1, 1],
    ]);
  });
});
