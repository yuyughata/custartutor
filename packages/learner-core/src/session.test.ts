import { goldenUnit2 } from '@custar/content-schema/fixtures';
import { parseUnit } from '@custar/content-schema';
import type { LessonUnit } from '@custar/content-schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { listLocalEvents } from './db/events';
import { migrate } from './db/migrate';
import { listPendingEvents, nextBatch } from './db/outbox';
import { correctResponse, wrongResponse } from './fakes/answers';
import { ManualClock } from './fakes/manual-clock';
import { SeededRandom } from './fakes/seeded-random';
import { UnknownQuestionError, UnknownSectionError } from './errors';
import { deriveUnitProgress } from './mastery';
import type { Ports } from './ports';
import { LessonSession } from './session';
import { CHILD_A, UNIT_1, failingDriver } from './test-helpers';
import { NodeSqliteDriver } from './testing/node-sqlite-driver';
import { WireEvent } from './wire';

const parsed = parseUnit(goldenUnit2);
if (parsed.kind !== 'lesson') throw new Error('fixture must be a lesson');
const unit: LessonUnit = parsed;

let db: NodeSqliteDriver;
let clock: ManualClock;
let random: SeededRandom;

beforeEach(async () => {
  db = new NodeSqliteDriver();
  await migrate(db);
  clock = new ManualClock();
  random = new SeededRandom('session');
});

function newSession(
  ports: Pick<Ports, 'db' | 'random' | 'clock'> = { db, random, clock },
): LessonSession {
  return new LessonSession({ unit, unitId: UNIT_1, versionNo: 3, childId: CHILD_A, ports });
}

async function outboxEvents(): Promise<WireEvent[]> {
  const batch = await nextBatch(db, 0, 1000);
  return batch.map((entry) => {
    if (!entry.event) throw new Error('corrupt outbox row');
    return entry.event;
  });
}

async function answerMasteryRight(session: LessonSession): Promise<void> {
  for (const id of session.masteryQuestions()) {
    await session.answer(id, correctResponse(unit.questions[id]!));
  }
}

describe('LessonSession events', () => {
  it('emits unit_started once, even when called twice or concurrently', async () => {
    const session = newSession();
    await Promise.all([session.start(), session.start()]);
    await session.start();
    const events = await outboxEvents();
    expect(events.map((e) => e.event_type)).toEqual(['unit_started']);
  });

  it('starts implicitly before the first answer, and a second session starts again', async () => {
    const first = newSession();
    await first.answer('qf_gutter', correctResponse(unit.questions.qf_gutter!));
    const second = newSession();
    await second.start();
    const types = (await outboxEvents()).map((e) => e.event_type);
    expect(types).toEqual(['unit_started', 'question_answered', 'unit_started']);
  });

  it('grades an answer and records result, score and a per-question attempt counter', async () => {
    const session = newSession();
    const question = unit.questions.qf_gutter!;
    const wrong = await session.answer('qf_gutter', wrongResponse(question));
    expect(wrong).toMatchObject({ result: 'incorrect', score: 0, attempt: 1 });
    const right = await session.answer('qf_gutter', correctResponse(question));
    expect(right).toMatchObject({ result: 'correct', score: 1, attempt: 2 });
    const other = await session.answer('qf_cook', correctResponse(unit.questions.qf_cook!));
    expect(other.attempt).toBe(1);

    const answered = (await outboxEvents()).filter((e) => e.event_type === 'question_answered');
    expect(answered.map((e) => e.payload)).toEqual([
      { question_id: 'qf_gutter', result: 'incorrect', score: 0, attempt: 1 },
      { question_id: 'qf_gutter', result: 'correct', score: 1, attempt: 2 },
      { question_id: 'qf_cook', result: 'correct', score: 1, attempt: 1 },
    ]);
  });

  it('records open-ended questions as ungraded with a null score', async () => {
    const session = newSession();
    const openId = Object.values(unit.questions).find((q) => q.kind === 'free_text')?.id;
    expect(openId).toBeDefined();
    const outcome = await session.answer(openId!, { kind: 'free_text', value: 'my kitchen' });
    expect(outcome).toMatchObject({ result: 'ungraded', score: null, attempt: 1 });
  });

  it('records a partly right answer with its fraction', async () => {
    const session = newSession();
    const outcome = await session.answer('mc_people', {
      kind: 'match',
      pairs: [
        { left: 'At home', right: 'family' },
        { left: 'At school', right: 'teachers and friends' },
        { left: 'Near our home', right: 'family' },
      ],
    });
    expect(outcome.result).toBe('partial');
    expect(outcome.score).toBeCloseTo(2 / 3, 4);
  });

  it('rejects unknown questions and sections without writing anything', async () => {
    const session = newSession();
    await expect(session.answer('nope', { kind: 'mcq', selected_index: 0 })).rejects.toBeInstanceOf(
      UnknownQuestionError,
    );
    await expect(session.completeSection('nope')).rejects.toBeInstanceOf(UnknownSectionError);
    expect(await outboxEvents()).toEqual([]);
  });

  it('records each section once per session', async () => {
    const session = newSession();
    const sectionId = unit.sections[0]!.id;
    expect(await session.completeSection(sectionId)).toBe(true);
    expect(await session.completeSection(sectionId)).toBe(false);
    const sections = (await outboxEvents()).filter((e) => e.event_type === 'section_completed');
    expect(sections).toHaveLength(1);
    expect(sections[0]?.payload).toEqual({ section_id: sectionId });
  });

  it('writes every event to local_event and outbox with unique ids and rising device_seq', async () => {
    const session = newSession();
    await session.completeSection(unit.sections[0]!.id);
    await session.answer('qf_gutter', correctResponse(unit.questions.qf_gutter!));
    const events = await outboxEvents();
    const local = await listLocalEvents(db, { childId: CHILD_A, unitId: UNIT_1 });
    expect(local.map((e) => e.client_event_id)).toEqual(events.map((e) => e.client_event_id));
    expect(events.map((e) => e.device_seq)).toEqual([1, 2, 3]);
    expect(new Set(events.map((e) => e.client_event_id)).size).toBe(3);
    for (const event of events) expect(WireEvent.safeParse(event).success).toBe(true);
    expect(events.every((e) => e.unit_id === UNIT_1 && e.child_id === CHILD_A)).toBe(true);
  });

  it('stamps occurred_at from the clock', async () => {
    const session = newSession();
    clock.advance(5 * 60_000);
    await session.start();
    const [event] = await outboxEvents();
    expect(event?.occurred_at).toBe(new Date(clock.now()).toISOString());
  });

  it('is atomic: a failing outbox write leaves no local_event and no sequence gap', async () => {
    const broken = failingDriver(db, (sql) => sql.includes('INSERT INTO outbox'));
    const session = newSession({ db: broken, random, clock });
    await expect(session.start()).rejects.toThrow('injected failure');
    expect(await db.all('SELECT * FROM local_event')).toEqual([]);
    // the failed start can be retried on a working connection
    const retry = newSession();
    await retry.start();
    expect((await outboxEvents())[0]?.device_seq).toBe(1);
  });

  it('lets a failed start be retried on the same session', async () => {
    let failing = true;
    const flaky = failingDriver(db, (sql) => failing && sql.includes('INSERT INTO outbox'));
    const session = newSession({ db: flaky, random, clock });
    await expect(session.start()).rejects.toThrow();
    failing = false;
    await session.start();
    expect((await outboxEvents()).map((e) => e.event_type)).toEqual(['unit_started']);
  });
});

describe('LessonSession mastery', () => {
  it('never grants mastery from practice answers or finished sections', async () => {
    const session = newSession();
    for (const section of unit.sections) await session.completeSection(section.id);
    for (const question of Object.values(unit.questions)) {
      await session.answer(question.id, correctResponse(question));
    }
    const events = await outboxEvents();
    expect(events.some((e) => e.event_type === 'mastery_check_completed')).toBe(false);
    expect(events.some((e) => e.event_type === 'unit_completed')).toBe(false);
    expect(deriveUnitProgress(events)?.status).toBe('in_progress');
  });

  it('records a passing check and unit_completed together', async () => {
    const session = newSession();
    await answerMasteryRight(session);
    expect(session.masteryCheckReady()).toBe(true);
    const submission = await session.submitMasteryCheck();
    expect(submission).toMatchObject({ score: 1, passed: true, question_count: 3, version_no: 3 });

    const events = await outboxEvents();
    const tail = events.slice(-2);
    expect(tail.map((e) => e.event_type)).toEqual(['mastery_check_completed', 'unit_completed']);
    expect(tail[0]?.payload).toEqual({ score: 1, passed: true, question_count: 3, version_no: 3 });
    expect(deriveUnitProgress(events)).toMatchObject({ status: 'mastered', attempts: 1 });
    expect(await listPendingEvents(db, CHILD_A, UNIT_1)).toHaveLength(events.length);
  });

  it('records a failing check without unit_completed, then allows a clean retry', async () => {
    const session = newSession();
    for (const id of session.masteryQuestions()) {
      await session.answer(id, wrongResponse(unit.questions[id]!));
    }
    const first = await session.submitMasteryCheck();
    expect(first).toMatchObject({ passed: false, score: 0 });
    let events = await outboxEvents();
    expect(events.some((e) => e.event_type === 'unit_completed')).toBe(false);
    expect(deriveUnitProgress(events)?.status).toBe('in_progress');

    // responses were cleared: submitting again without answering scores 0, it cannot reuse old answers
    expect(session.masteryCheckReady()).toBe(false);
    expect((await session.submitMasteryCheck()).score).toBe(0);

    await answerMasteryRight(session);
    const retry = await session.submitMasteryCheck();
    expect(retry.passed).toBe(true);
    events = await outboxEvents();
    expect(deriveUnitProgress(events)).toMatchObject({
      status: 'mastered',
      attempts: 3,
      mastery_score: 1,
    });
    // the retry's answers restart at attempt 1
    const lastAnswers = events.filter((e) => e.event_type === 'question_answered').slice(-3);
    expect(
      lastAnswers.every((e) => e.event_type === 'question_answered' && e.payload.attempt === 1),
    ).toBe(true);
  });

  it('grades the LATEST response to each mastery question', async () => {
    const session = newSession();
    const [first, ...rest] = session.masteryQuestions();
    await session.answer(first!, wrongResponse(unit.questions[first!]!));
    await session.answer(first!, correctResponse(unit.questions[first!]!));
    for (const id of rest) await session.answer(id, correctResponse(unit.questions[id]!));
    expect((await session.submitMasteryCheck()).passed).toBe(true);
  });

  it('records a mastery check with missing answers as a failure, not an error', async () => {
    const session = newSession();
    const submission = await session.submitMasteryCheck();
    expect(submission).toMatchObject({ passed: false, score: 0, question_count: 3 });
  });

  it('writes mastery and completion atomically', async () => {
    const broken = failingDriver(
      db,
      (sql, params) =>
        sql.includes('INSERT INTO local_event') && (params?.includes('unit_completed') ?? false),
    );
    const session = newSession({ db: broken, random, clock });
    await answerMasteryRight(session);
    await expect(session.submitMasteryCheck()).rejects.toThrow('injected failure');
    const types = (await outboxEvents()).map((e) => e.event_type);
    expect(types).not.toContain('mastery_check_completed');
    expect(types).not.toContain('unit_completed');
  });
});
