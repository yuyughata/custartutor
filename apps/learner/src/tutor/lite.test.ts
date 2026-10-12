import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '@custar/learner-core';
import { NodeSqliteDriver } from '@custar/learner-core/testing';
import { parseUnit, type UnitContent } from '@custar/content-schema';
import { goldenUnit2, marketDayMathsUnit } from '@custar/content-schema/fixtures';
import { LiteSession } from './liteSession';
import { tutorLiteEngine } from './lite';
import { liteQuestions, liteTargets } from './sections';
import { CHILD, UNIT } from './testkit';

// The real Tutor Lite engine of tutor-core, driven through the app's controller and the learner-core table.

let db: NodeSqliteDriver;
let clock = 5_000;

const golden = parseUnit(goldenUnit2);
const market = parseUnit(marketDayMathsUnit);

function sessionFor(unit: UnitContent, sectionId: string) {
  const target = liteTargets(unit).find((t) => t.sectionId === sectionId);
  if (!target) throw new Error(`no script in ${sectionId}`);
  return new LiteSession({
    engine: tutorLiteEngine,
    db,
    now: () => (clock += 10),
    childId: CHILD,
    unitId: UNIT,
    sectionId,
    script: target.script,
    questions: liteQuestions(unit),
  });
}

beforeEach(async () => {
  db = new NodeSqliteDriver();
  await migrate(db);
});

describe('LiteSession with the real Tutor Lite engine', () => {
  it('starts a golden-unit script and asks its first question', async () => {
    const view = await sessionFor(golden, 'places_in_school').open();
    expect(view.expecting).toBe(true);
    expect(view.lines.at(-1)?.text).toMatch(/learn/i);
    expect(view.lines.every((line) => line.text.length > 0)).toBe(true);
  });

  it('grades a typed reply with the same matching as fill-in-the-blank', async () => {
    const lite = sessionFor(golden, 'come_and_explore');
    await lite.open();
    const wrong = await lite.reply('the moon');
    expect(wrong.graded).toEqual({ correct: false });
    const right = await lite.reply('the school');
    expect(right.graded).toEqual({ correct: true });
  });

  it('runs a script to the end and remembers that it finished', async () => {
    const lite = sessionFor(golden, 'remember_senses');
    await lite.open();
    const done = await lite.reply('touch');
    expect(done.finished).toBe(true);
    expect(done.lines.some((line) => line.kind === 'wrap')).toBe(true);
    const row = await db.get<{ state_json: string }>('SELECT state_json FROM tutor_lite_state');
    expect(JSON.parse(row?.state_json ?? '{}')).toMatchObject({ finished: true, node_id: null });
    // a restart shows it as finished
    const again = await sessionFor(golden, 'remember_senses').open();
    expect(again).toMatchObject({ finished: true, resumed: true });
  });

  it('a restart in the middle resumes at the same question with the same counters', async () => {
    const first = sessionFor(golden, 'places_in_school');
    const opened = await first.open();
    const question = opened.lines.at(-1)?.text;
    await first.reply('banana'); // one miss: attempts = 1
    const row = await db.get<{ state_json: string }>('SELECT state_json FROM tutor_lite_state');
    expect(JSON.parse(row?.state_json ?? '{}')).toMatchObject({ attempts: 1 });

    const resumed = await sessionFor(golden, 'places_in_school').open();
    expect(resumed.resumed).toBe(true);
    expect(resumed.expecting).toBe(true);
    expect(resumed.lines.map((line) => line.text)).toEqual([question]);
    // the second miss now offers the hint, exactly as it would have without the restart
    const second = sessionFor(golden, 'places_in_school');
    await second.open();
    const missed = await second.reply('banana');
    expect(missed.lines.some((line) => line.kind === 'hint')).toBe(true);
  });

  it('is never stuck: hints and skip always move the child on', async () => {
    const lite = sessionFor(golden, 'places_in_school');
    const first = await lite.open();
    const hint = await lite.hint();
    expect(hint.lines.length).toBe(1);
    expect(hint.expecting).toBe(true);
    const skipped = await lite.skip();
    expect(skipped.lines.length).toBeGreaterThan(0);
    expect(skipped.lines[0]?.text).not.toBe(first.lines.at(-1)?.text);
  });

  it('offers the options of a multiple-choice question as tappable choices', async () => {
    // find a scripted node that grades with an mcq question, or build one from the market unit's mcq
    const mcq = Object.values(liteQuestions(market)).find((q) => q.kind === 'mcq');
    if (mcq?.kind !== 'mcq') throw new Error('fixture has no mcq question');
    const script = {
      nodes: [
        {
          id: 'n_mcq',
          say: mcq.prompt,
          expect: { question_id: mcq.id },
          on_correct: ['Yes!'],
          on_incorrect: ['Not quite.'],
          hint: [],
        },
      ],
    };
    const lite = new LiteSession({
      engine: tutorLiteEngine,
      db,
      now: () => (clock += 10),
      childId: CHILD,
      unitId: UNIT,
      sectionId: 'mcq_part',
      script,
      questions: liteQuestions(market),
    });
    const view = await lite.open();
    expect(view.choices).toEqual(mcq.options);
    // tapping the right option (its text) is graded as correct
    const correct = mcq.options[mcq.answer.correct_index] as string;
    const done = await lite.reply(correct);
    expect(done.graded).toEqual({ correct: true });
  });

  it('never writes an event, an outbox row or progress, and keeps nothing the child typed', async () => {
    const lite = sessionFor(golden, 'come_and_explore');
    await lite.open();
    await lite.reply('call me on 08031234567');
    await lite.reply('the school');
    for (const table of ['outbox', 'local_event', 'unit_progress']) {
      expect(await db.all(`SELECT * FROM ${table}`), table).toEqual([]);
    }
    const dump = JSON.stringify(await db.all('SELECT * FROM tutor_lite_state'));
    expect(dump).not.toContain('08031234567');
    expect(dump).not.toContain('the school');
  });
});
