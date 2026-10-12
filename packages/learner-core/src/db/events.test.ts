import { beforeEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../fakes/manual-clock';
import { SeededRandom } from '../fakes/seeded-random';
import { CHILD_A, CHILD_B, UNIT_1 } from '../test-helpers';
import { NodeSqliteDriver } from '../testing/node-sqlite-driver';
import { appendEvent, listLocalEvents, pruneSyncedEvents } from './events';
import { getMeta, META } from './meta';
import { migrate } from './migrate';
import {
  listDead,
  listPendingEvents,
  markDead,
  markDelivered,
  markFailed,
  nextBatch,
  outboxCounts,
  purgeUnknownChildren,
  reviveDead,
} from './outbox';

let db: NodeSqliteDriver;
let ports: { db: NodeSqliteDriver; random: SeededRandom; clock: ManualClock };

beforeEach(async () => {
  db = new NodeSqliteDriver();
  await migrate(db);
  ports = { db, random: new SeededRandom('events'), clock: new ManualClock() };
});

const started = (childId = CHILD_A) => ({
  child_id: childId,
  unit_id: UNIT_1,
  occurred_at: '2026-10-12T08:00:00.000Z',
  event_type: 'unit_started' as const,
  payload: {},
});

describe('appendEvent', () => {
  it('writes local_event and outbox together with a device id and increasing device_seq', async () => {
    const a = await appendEvent(ports, started());
    const b = await appendEvent(ports, started());
    expect([a.device_seq, b.device_seq]).toEqual([1, 2]);
    expect(a.device_id).toBe(b.device_id);
    expect(a.device_id).toBe(await getMeta(db, META.deviceId));
    expect(a.client_event_id).not.toBe(b.client_event_id);
    expect((await db.all('SELECT * FROM local_event')).length).toBe(2);
    expect((await db.all('SELECT * FROM outbox')).length).toBe(2);
    const stored = await db.get<{ payload_json: string }>(
      'SELECT payload_json FROM outbox WHERE client_event_id = ?',
      [a.client_event_id],
    );
    expect(JSON.parse(stored?.payload_json ?? '{}')).toEqual(a);
  });

  it('hands out unique, gap-free sequence numbers under concurrency', async () => {
    const events = await Promise.all(
      Array.from({ length: 25 }, () => appendEvent(ports, started())),
    );
    const seqs = events.map((e) => e.device_seq).sort((x, y) => x - y);
    expect(seqs).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  });

  it('writes nothing and consumes no sequence number when the event is invalid', async () => {
    await expect(
      appendEvent(ports, {
        ...started(),
        event_type: 'section_completed',
        payload: { section_id: '' },
      }),
    ).rejects.toThrow();
    expect((await db.all('SELECT * FROM local_event')).length).toBe(0);
    expect((await db.all('SELECT * FROM outbox')).length).toBe(0);
    expect(await getMeta(db, META.deviceSeq)).toBeNull();
    const next = await appendEvent(ports, started());
    expect(next.device_seq).toBe(1);
  });

  it('lists local events per child and prunes old synced ones', async () => {
    const a = await appendEvent(ports, started());
    await appendEvent(ports, started(CHILD_B));
    expect((await listLocalEvents(db, { childId: CHILD_A })).length).toBe(1);
    expect((await listLocalEvents(db, { childId: CHILD_A, unitId: UNIT_1 })).length).toBe(1);
    await markDelivered(db, [a.client_event_id], 1000);
    expect(await pruneSyncedEvents(db, 500)).toBe(0);
    expect(await pruneSyncedEvents(db, 2000)).toBe(1);
    expect((await listLocalEvents(db, { childId: CHILD_A })).length).toBe(0);
  });
});

describe('outbox', () => {
  it('returns live rows oldest first, after a cursor, and respects the limit', async () => {
    for (let i = 0; i < 5; i += 1) await appendEvent(ports, started());
    const first = await nextBatch(db, 0, 3);
    expect(first.map((e) => e.row.device_seq)).toEqual([1, 2, 3]);
    expect(first.every((e) => e.event !== null)).toBe(true);
    const rest = await nextBatch(db, 3, 10);
    expect(rest.map((e) => e.row.device_seq)).toEqual([4, 5]);
  });

  it('counts attempts, then dead-letters at five without hiding later rows', async () => {
    const a = await appendEvent(ports, started());
    const b = await appendEvent(ports, started());
    for (let i = 1; i <= 4; i += 1) {
      expect(await markFailed(db, a.client_event_id, 'bad')).toEqual({ dead: false, attempts: i });
    }
    expect(await markFailed(db, a.client_event_id, 'bad')).toEqual({ dead: true, attempts: 5 });
    expect((await nextBatch(db, 0, 10)).map((e) => e.row.client_event_id)).toEqual([
      b.client_event_id,
    ]);
    expect(await outboxCounts(db)).toEqual({ pending: 1, dead: 1 });
    expect((await listDead(db))[0]?.last_error).toBe('bad');
    expect(await reviveDead(db)).toBe(1);
    expect(await outboxCounts(db)).toEqual({ pending: 2, dead: 0 });
  });

  it('delivers rows: removes them from the outbox and stamps the local log', async () => {
    const a = await appendEvent(ports, started());
    await markDelivered(db, [a.client_event_id], 777);
    expect((await db.all('SELECT * FROM outbox')).length).toBe(0);
    expect((await listLocalEvents(db, { childId: CHILD_A }))[0]?.synced_at).toBe(777);
    await markDelivered(db, [], 1); // empty list is a no-op
  });

  it('flags a corrupt row and can dead-letter it', async () => {
    const a = await appendEvent(ports, started());
    await db.run('UPDATE outbox SET payload_json = ? WHERE client_event_id = ?', [
      '{not json',
      a.client_event_id,
    ]);
    const [entry] = await nextBatch(db, 0, 10);
    expect(entry?.event).toBeNull();
    await markDead(db, a.client_event_id, 'corrupt');
    expect(await nextBatch(db, 0, 10)).toEqual([]);
  });

  it('lists pending events per child and unit, excluding dead rows', async () => {
    const a = await appendEvent(ports, started());
    await appendEvent(ports, started(CHILD_B));
    expect((await listPendingEvents(db, CHILD_A)).map((e) => e.client_event_id)).toEqual([
      a.client_event_id,
    ]);
    expect(await listPendingEvents(db, CHILD_A, 'other-unit')).toEqual([]);
    await markDead(db, a.client_event_id, 'x');
    expect(await listPendingEvents(db, CHILD_A)).toEqual([]);
  });

  it('purges rows of children that are no longer known', async () => {
    await db.run(
      `INSERT INTO child (id, household_id, display_alias, level_code, reading_mode) VALUES (?, 'h', 'Ada', 'P1', 'reader')`,
      [CHILD_A],
    );
    await appendEvent(ports, started(CHILD_A));
    await appendEvent(ports, started(CHILD_B));
    await db.transaction((tx) => purgeUnknownChildren(tx));
    expect((await db.all('SELECT child_id FROM outbox')).map((r) => r.child_id)).toEqual([CHILD_A]);
    expect((await db.all('SELECT child_id FROM local_event')).map((r) => r.child_id)).toEqual([
      CHILD_A,
    ]);
  });
});
