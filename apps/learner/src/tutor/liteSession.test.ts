import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '@custar/learner-core';
import { NodeSqliteDriver } from '@custar/learner-core/testing';
import { DEMO_SCRIPT, fakeLiteEngine, CHILD, UNIT } from './testkit';
import { LiteSession, parseLiteState } from './liteSession';

let db: NodeSqliteDriver;
let clock = 1_000;

function session(overrides: Partial<ConstructorParameters<typeof LiteSession>[0]> = {}) {
  return new LiteSession({
    engine: fakeLiteEngine(),
    db,
    now: () => (clock += 10),
    childId: CHILD,
    unitId: UNIT,
    sectionId: 'concept_water',
    script: DEMO_SCRIPT,
    questions: {},
    ...overrides,
  });
}

async function savedState(): Promise<Record<string, unknown> | null> {
  const row = await db.get<{ state_json: string }>('SELECT state_json FROM tutor_lite_state');
  return row ? (JSON.parse(row.state_json) as Record<string, unknown>) : null;
}

beforeEach(async () => {
  db = new NodeSqliteDriver();
  await migrate(db);
  clock = 1_000;
});

describe('LiteSession', () => {
  it('starts the script, shows the lines up to the first question and saves the place', async () => {
    const view = await session().open();
    expect(view.lines.map((line) => line.text)).toEqual([
      'Hello! Let us talk about water.',
      'Where does a fish live?',
    ]);
    expect(view.expecting).toBe(true);
    expect(view.finished).toBe(false);
    expect(view.resumed).toBe(false);
    expect(await savedState()).toMatchObject({ node_id: 'n_ask', finished: false });
  });

  it('grades a reply, moves on and saves after every step', async () => {
    const lite = session();
    await lite.open();

    const wrong = await lite.reply('banana');
    expect(wrong.graded).toEqual({ correct: false });
    expect(wrong.expecting).toBe(true);
    expect(await savedState()).toMatchObject({ node_id: 'n_ask', attempts: 1 });

    const right = await lite.reply('In water');
    expect(right.graded).toEqual({ correct: true });
    expect(right.lines.map((line) => line.text)).toEqual([
      'Yes! A fish lives in water.',
      'What do we drink?',
    ]);
    expect(await savedState()).toMatchObject({ node_id: 'n_ask2', attempts: 0 });
  });

  it('offers hints and a skip, each saved', async () => {
    const lite = session();
    await lite.open();
    const hint = await lite.hint();
    expect(hint.lines.map((line) => line.text)).toEqual(['It is wet.']);
    expect(await savedState()).toMatchObject({ hints_used: 1 });

    const skipped = await lite.skip();
    expect(skipped.lines.map((line) => line.text)).toEqual(['What do we drink?']);
    expect(await savedState()).toMatchObject({ node_id: 'n_ask2' });
  });

  it('finishes the script and remembers it', async () => {
    const lite = session();
    await lite.open();
    await lite.reply('water');
    const done = await lite.reply('water');
    expect(done.finished).toBe(true);
    expect(done.expecting).toBe(false);
    expect(done.lines.map((line) => line.text)).toEqual(['Good!', 'Well done today.']);
    expect(await savedState()).toMatchObject({ node_id: null, finished: true });
  });

  it('resumes after a restart: the same place, asked again', async () => {
    const first = session();
    await first.open();
    await first.reply('water'); // now on n_ask2
    await first.hint();

    const restarted = session(); // a new object, as after the app is closed and reopened
    const view = await restarted.open();
    expect(view.resumed).toBe(true);
    expect(view.expecting).toBe(true);
    expect(view.lines.map((line) => line.text)).toEqual(['What do we drink?']);
    // and it carries on from there with the saved counters
    const next = await restarted.reply('water');
    expect(next.finished).toBe(true);
  });

  it('shows a finished part as finished, and starts again on request', async () => {
    const first = session();
    await first.open();
    await first.reply('water');
    await first.reply('water');

    const again = session();
    const view = await again.open();
    expect(view).toMatchObject({ finished: true, resumed: true, lines: [], expecting: false });

    const restarted = await again.restart();
    expect(restarted.finished).toBe(false);
    expect(restarted.lines[0]?.text).toBe('Hello! Let us talk about water.');
    expect(await savedState()).toMatchObject({ node_id: 'n_ask' });
  });

  it('keeps one saved place per part of the lesson', async () => {
    await session({ sectionId: 'part_a' }).open();
    await session({ sectionId: 'part_b' }).open();
    const rows = await db.all('SELECT section_id FROM tutor_lite_state ORDER BY section_id');
    expect(rows).toEqual([{ section_id: 'part_a' }, { section_id: 'part_b' }]);
  });

  it('starts over when the saved place does not fit the script (an updated lesson)', async () => {
    await db.run(
      'INSERT INTO tutor_lite_state (child_id, unit_id, section_id, state_json, updated_at) VALUES (?, ?, ?, ?, 1)',
      [
        CHILD,
        UNIT,
        'concept_water',
        JSON.stringify({
          node_id: 'gone',
          attempts: 0,
          hints_used: 0,
          cursors: {},
          finished: false,
        }),
      ],
    );
    const view = await session().open();
    expect(view.resumed).toBe(false);
    expect(view.lines[0]?.text).toBe('Hello! Let us talk about water.');
  });

  it('survives a database that refuses to save', async () => {
    const failing = {
      ...db,
      run: () => Promise.reject(new Error('disk full')),
      get: () => Promise.resolve(undefined),
      all: db.all.bind(db),
      exec: db.exec.bind(db),
      transaction: db.transaction.bind(db),
    };
    const lite = session({ db: failing });
    const view = await lite.open();
    expect(view.lines.length).toBeGreaterThan(0);
    expect((await lite.reply('water')).graded).toEqual({ correct: true });
  });

  it('writes NOTHING the child typed anywhere in the database', async () => {
    const lite = session();
    await lite.open();
    const secret = 'my number is 08031234567 and my name is Chidinma';
    await lite.reply(secret);
    await lite.reply('banana');
    const tables = await db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    );
    for (const { name } of tables) {
      const dump = JSON.stringify(await db.all(`SELECT * FROM ${name}`));
      expect(dump, name).not.toContain('08031234567');
      expect(dump, name).not.toContain('Chidinma');
      expect(dump, name).not.toContain('banana');
    }
  });

  it('never writes progress events or an outbox row (mastery stays with the lesson)', async () => {
    const lite = session();
    await lite.open();
    await lite.reply('water');
    await lite.reply('water');
    await lite.hint();
    await lite.skip();
    for (const table of ['outbox', 'local_event', 'unit_progress']) {
      expect(await db.all(`SELECT * FROM ${table}`), table).toEqual([]);
    }
  });
});

describe('parseLiteState', () => {
  it('accepts a well-formed state and rejects damage', () => {
    const good = {
      node_id: 'n_ask',
      attempts: 1,
      hints_used: 0,
      cursors: { n_ask: 1 },
      finished: false,
    };
    expect(parseLiteState(JSON.stringify(good), DEMO_SCRIPT)).toEqual(good);
    expect(parseLiteState('{not json', DEMO_SCRIPT)).toBeNull();
    expect(parseLiteState('null', DEMO_SCRIPT)).toBeNull();
    expect(parseLiteState(JSON.stringify({ ...good, node_id: 'missing' }), DEMO_SCRIPT)).toBeNull();
    expect(parseLiteState(JSON.stringify({ ...good, attempts: 'x' }), DEMO_SCRIPT)).toBeNull();
    expect(
      parseLiteState(JSON.stringify({ ...good, cursors: { n_ask: 'x' } }), DEMO_SCRIPT),
    ).toBeNull();
    expect(parseLiteState(JSON.stringify({ ...good, finished: 1 }), DEMO_SCRIPT)).toBeNull();
    expect(
      parseLiteState(JSON.stringify({ ...good, node_id: null, finished: true }), DEMO_SCRIPT),
    ).toMatchObject({
      node_id: null,
      finished: true,
    });
  });
});
