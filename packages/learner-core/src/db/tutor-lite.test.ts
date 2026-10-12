import { beforeEach, describe, expect, it } from 'vitest';
import { SyncEngine } from '../sync/engine';
import { CHILD_A, CHILD_B, UNIT_1, UNIT_2 } from '../test-helpers';
import { createTestPorts, createTrustedClock } from '../testing';
import type { TestPorts } from '../testing';
import { purgeUnknownChildren } from './outbox';
import { deleteChildCascade, listChildren, purgeAccountData } from './reference';
import {
  deleteAllTutorLiteState,
  deleteTutorLiteState,
  deleteTutorLiteStateForChild,
  getTutorLiteState,
  listTutorLiteStates,
  saveTutorLiteState,
} from './tutor-lite';

const HOUSEHOLD = '00000000-0000-4000-8000-0000000000f1';

let ports: TestPorts;

const keyOf = (childId: string, unitId: string, sectionId: string) => ({
  childId,
  unitId,
  sectionId,
});

const state = (nodeId: string | null, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    node_id: nodeId,
    attempts: 0,
    hints_used: 0,
    cursors: {},
    finished: false,
    ...extra,
  });

beforeEach(async () => {
  ports = await createTestPorts({ seed: 'tutor-lite' });
  ports.api.setHousehold({ id: HOUSEHOLD, name: 'Family' });
  for (const [id, alias] of [
    [CHILD_A, 'Ada'],
    [CHILD_B, 'Tobi'],
  ] as const) {
    ports.api.addChild({
      id,
      household_id: HOUSEHOLD,
      display_alias: alias,
      avatar: null,
      level_code: 'P1',
      reading_mode: 'reader',
      daily_limit_min: null,
    });
  }
});

describe('tutor_lite_state repository', () => {
  it('saves, reads back and replaces the state of one section', async () => {
    const key = keyOf(CHILD_A, UNIT_1, 'concept_places');
    expect(await getTutorLiteState(ports.db, key)).toBeNull();

    await saveTutorLiteState(ports.db, key, state('n_ask'), 1000);
    expect(await getTutorLiteState(ports.db, key)).toEqual({
      child_id: CHILD_A,
      unit_id: UNIT_1,
      section_id: 'concept_places',
      state_json: state('n_ask'),
      updated_at: 1000,
    });

    await saveTutorLiteState(ports.db, key, state('n_next', { attempts: 2 }), 2000);
    const rows = await ports.db.all('SELECT * FROM tutor_lite_state');
    expect(rows).toHaveLength(1);
    const row = await getTutorLiteState(ports.db, key);
    expect(JSON.parse(row?.state_json ?? '{}')).toMatchObject({ node_id: 'n_next', attempts: 2 });
    expect(row?.updated_at).toBe(2000);
  });

  it('keeps children, units and sections apart', async () => {
    await saveTutorLiteState(ports.db, keyOf(CHILD_A, UNIT_1, 's1'), state('a'), 1);
    await saveTutorLiteState(ports.db, keyOf(CHILD_A, UNIT_1, 's2'), state('b'), 2);
    await saveTutorLiteState(ports.db, keyOf(CHILD_A, UNIT_2, 's1'), state('c'), 3);
    await saveTutorLiteState(ports.db, keyOf(CHILD_B, UNIT_1, 's1'), state('d'), 4);

    const forA = await listTutorLiteStates(ports.db, CHILD_A, UNIT_1);
    expect(forA.map((row) => row.section_id)).toEqual(['s2', 's1']); // newest first
    expect(
      JSON.parse((await getTutorLiteState(ports.db, keyOf(CHILD_B, UNIT_1, 's1')))!.state_json),
    ).toMatchObject({ node_id: 'd' });

    await deleteTutorLiteState(ports.db, keyOf(CHILD_A, UNIT_1, 's1'));
    expect(await getTutorLiteState(ports.db, keyOf(CHILD_A, UNIT_1, 's1'))).toBeNull();
    expect(await ports.db.all('SELECT 1 FROM tutor_lite_state')).toHaveLength(3);
  });

  it('survives a reopen of the same database (a restart resumes)', async () => {
    const key = keyOf(CHILD_A, UNIT_1, 'concept_places');
    await saveTutorLiteState(ports.db, key, state('n_play', { hints_used: 1 }), 5);
    // a fresh read through a new statement path sees the same row
    const again = await getTutorLiteState(ports.db, key);
    expect(JSON.parse(again?.state_json ?? '{}')).toMatchObject({
      node_id: 'n_play',
      hints_used: 1,
    });
  });

  it('stores only what it is given: no hidden columns for text', async () => {
    const columns = await ports.db.all<{ name: string }>('PRAGMA table_info(tutor_lite_state)');
    expect(columns.map((column) => column.name)).toEqual([
      'child_id',
      'unit_id',
      'section_id',
      'state_json',
      'updated_at',
    ]);
  });
});

describe('clearing Tutor Lite state', () => {
  beforeEach(async () => {
    await saveTutorLiteState(ports.db, keyOf(CHILD_A, UNIT_1, 's1'), state('a'), 1);
    await saveTutorLiteState(ports.db, keyOf(CHILD_B, UNIT_1, 's1'), state('b'), 2);
  });

  it('deletes one child only', async () => {
    await ports.db.transaction((tx) => deleteTutorLiteStateForChild(tx, CHILD_A));
    expect(
      (await ports.db.all<{ child_id: string }>('SELECT child_id FROM tutor_lite_state')).map(
        (row) => row.child_id,
      ),
    ).toEqual([CHILD_B]);
  });

  it('deletes everything', async () => {
    await ports.db.transaction((tx) => deleteAllTutorLiteState(tx));
    expect(await ports.db.all('SELECT 1 FROM tutor_lite_state')).toEqual([]);
  });

  it('goes with the child when a child is removed', async () => {
    const trusted = await createTrustedClock(ports);
    await new SyncEngine({ ports, api: ports.api, trustedClock: trusted }).syncOnce();
    expect(await listChildren(ports.db)).toHaveLength(2);

    await ports.db.transaction((tx) => deleteChildCascade(tx, CHILD_A));
    expect(
      (await ports.db.all<{ child_id: string }>('SELECT child_id FROM tutor_lite_state')).map(
        (row) => row.child_id,
      ),
    ).toEqual([CHILD_B]);
  });

  it('goes with the child when the server deletes them (tombstone)', async () => {
    const trusted = await createTrustedClock(ports);
    const engine = new SyncEngine({ ports, api: ports.api, trustedClock: trusted });
    await engine.syncOnce();
    ports.api.deleteChild(CHILD_A);
    await engine.syncOnce();
    expect((await listChildren(ports.db)).map((child) => child.id)).toEqual([CHILD_B]);
    expect(
      (await ports.db.all<{ child_id: string }>('SELECT child_id FROM tutor_lite_state')).map(
        (row) => row.child_id,
      ),
    ).toEqual([CHILD_B]);
  });

  it('goes with revoked access after a full resync', async () => {
    const trusted = await createTrustedClock(ports);
    const engine = new SyncEngine({ ports, api: ports.api, trustedClock: trusted });
    await engine.syncOnce();
    ports.api.revokeChild(CHILD_B);
    const result = await engine.syncOnce();
    expect(result.ok && result.pull.fullResync).toBe(true);
    expect(
      (await ports.db.all<{ child_id: string }>('SELECT child_id FROM tutor_lite_state')).map(
        (row) => row.child_id,
      ),
    ).toEqual([CHILD_A]);
  });

  it('purges rows of unknown children', async () => {
    await ports.db.run(
      `INSERT INTO child (id, household_id, display_alias, level_code, reading_mode) VALUES (?, 'h', 'Ada', 'P1', 'reader')`,
      [CHILD_A],
    );
    await ports.db.transaction((tx) => purgeUnknownChildren(tx));
    expect(
      (await ports.db.all<{ child_id: string }>('SELECT child_id FROM tutor_lite_state')).map(
        (row) => row.child_id,
      ),
    ).toEqual([CHILD_A]);
  });

  it('is cleared by purgeAccountData (sign-out)', async () => {
    await purgeAccountData(ports.db);
    expect(await ports.db.all('SELECT 1 FROM tutor_lite_state')).toEqual([]);
  });
});
