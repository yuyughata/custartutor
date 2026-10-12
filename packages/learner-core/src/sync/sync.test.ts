import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrustedClock } from '../clock';
import { appendEvents } from '../db/events';
import type { NewEvent } from '../db/events';
import { META, getMeta, getMetaNumber } from '../db/meta';
import { markFailed, nextBatch, outboxCounts } from '../db/outbox';
import { listChildren, listSubjects, listUnits, latestPublished } from '../db/reference';
import { listChildProgress } from '../db/progress';
import { SyncApiError } from '../api';
import { buildPackFiles } from '../fakes/pack-builder';
import { CHILD_A, CHILD_B, UNIT_1, UNIT_2, failingDriver } from '../test-helpers';
import { createTestPorts, createTrustedClock } from '../testing';
import type { TestPorts } from '../testing';
import type { PullResponse } from '../wire';
import { parseUnit } from '@custar/content-schema';
import { goldenUnit2 } from '@custar/content-schema/fixtures';
import { SyncEngine } from './engine';

const HOUSEHOLD = '00000000-0000-4000-8000-0000000000f1';
const SUBJECT = '00000000-0000-4000-8000-0000000000e1';

let ports: TestPorts;
let trusted: TrustedClock;

function seedServer(): void {
  const { api } = ports;
  api.setHousehold({ id: HOUSEHOLD, name: 'Test Family' });
  api.addSubject({
    id: SUBJECT,
    slug: 'basic-science',
    name: 'Basic Science',
    kind: 'core',
    curriculum_source: 'nerdc',
    icon: null,
    colour: null,
    sort: 1,
  });
  for (const [id, alias] of [
    [CHILD_A, 'Ada'],
    [CHILD_B, 'Tobi'],
  ] as const) {
    api.addChild({
      id,
      household_id: HOUSEHOLD,
      display_alias: alias,
      avatar: null,
      level_code: 'P1',
      reading_mode: 'reader',
      daily_limit_min: null,
    });
  }
  [UNIT_1, UNIT_2].forEach((id, index) => {
    api.addUnit({
      id,
      subject_id: SUBJECT,
      chapter_number: 1,
      chapter_title: 'Our World',
      unit_no: index + 1,
      week_no: index + 1,
      kind: 'lesson',
      title: `Unit ${index + 1}`,
      objective: 'Learn things',
      stage: 'absorb',
      level_code: 'P1',
      term: 1,
    });
  });
}

function engine(
  over: { pullLimit?: number; db?: TestPorts['db'] | ReturnType<typeof failingDriver> } = {},
) {
  return new SyncEngine({
    ports: { db: over.db ?? ports.db, clock: ports.clock, random: ports.random },
    api: ports.api,
    trustedClock: trusted,
    ...(over.pullLimit !== undefined ? { pullLimit: over.pullLimit } : {}),
  });
}

const started = (childId: string, unitId = UNIT_1): NewEvent => ({
  child_id: childId,
  unit_id: unitId,
  occurred_at: new Date(ports.clock.now()).toISOString(),
  event_type: 'unit_started',
  payload: {},
});

const section = (childId: string, sectionId: string, unitId = UNIT_1): NewEvent => ({
  child_id: childId,
  unit_id: unitId,
  occurred_at: new Date(ports.clock.now()).toISOString(),
  event_type: 'section_completed',
  payload: { section_id: sectionId },
});

const mastery = (childId: string, score: number, unitId = UNIT_1): NewEvent => ({
  child_id: childId,
  unit_id: unitId,
  occurred_at: new Date(ports.clock.now()).toISOString(),
  event_type: 'mastery_check_completed',
  payload: { score, passed: score >= 0.8, question_count: 3, version_no: 1 },
});

beforeEach(async () => {
  ports = await createTestPorts({ seed: 'sync' });
  trusted = await createTrustedClock(ports);
  seedServer();
});

describe('pull', () => {
  it('downloads household, children, subjects and units and stores the cursor', async () => {
    const result = await engine().syncOnce();
    expect(result.ok).toBe(true);
    expect((await listChildren(ports.db)).map((c) => c.display_alias).sort()).toEqual([
      'Ada',
      'Tobi',
    ]);
    expect((await listSubjects(ports.db)).map((s) => s.slug)).toEqual(['basic-science']);
    expect((await listUnits(ports.db)).map((u) => u.id)).toEqual([UNIT_1, UNIT_2]);
    expect(await getMetaNumber(ports.db, META.lastSyncSeq)).toBe(ports.api.currentSyncSeq());
    expect(await getMetaNumber(ports.db, META.membershipEpoch)).toBe(ports.api.currentEpoch());
    const household = await ports.db.get('SELECT * FROM household');
    expect(household).toEqual({ id: HOUSEHOLD, name: 'Test Family' });
  });

  it('pages through large changes and stops when has_more is false', async () => {
    const result = await engine({ pullLimit: 2 }).syncOnce();
    expect(result.ok && result.pull.pages).toBeGreaterThan(2);
    expect(ports.api.pullRequests.every((r) => r.limit === 2)).toBe(true);
    // each request continued from the previous page's cursor
    const cursors = ports.api.pullRequests.map((r) => r.sinceSeq);
    expect([...cursors].sort((a, b) => a - b)).toEqual(cursors);
    expect(new Set(cursors).size).toBe(cursors.length);
    expect(await listUnits(ports.db)).toHaveLength(2);
  });

  it('is incremental: the second sync only asks for what is new', async () => {
    const e = engine();
    await e.syncOnce();
    ports.api.updateChild(CHILD_A, { display_alias: 'Ada B.' });
    const result = await e.syncOnce();
    expect(result.ok && result.pull.rows).toBe(1);
    expect((await listChildren(ports.db)).find((c) => c.id === CHILD_A)?.display_alias).toBe(
      'Ada B.',
    );
    const empty = await e.syncOnce();
    expect(empty.ok && empty.pull.rows).toBe(0);
  });

  it('applies tombstones: unit, published and child (with their local data)', async () => {
    const pack = await buildPackFiles(parseUnit(goldenUnit2), { unitId: UNIT_1, versionNo: 1 });
    ports.api.publishPack(pack);
    const e = engine();
    await appendEvents(ports, [started(CHILD_A), started(CHILD_B)]);
    await e.syncOnce();
    expect((await latestPublished(ports.db, UNIT_1))?.version_no).toBe(1);
    expect((await listChildProgress(ports.db, CHILD_A)).size).toBe(1);
    // an unsent event for child A, to prove the cascade removes it
    await appendEvents(ports, [started(CHILD_A, UNIT_2)]);

    ports.api.deleteChild(CHILD_A);
    ports.api.deleteUnit(UNIT_2);
    ports.api.unpublish(UNIT_1, 1);
    // the server would reject child A's pending row; the tombstone must purge it locally either way
    const result = await e.syncOnce();
    expect(result.ok).toBe(true);

    expect((await listChildren(ports.db)).map((c) => c.id)).toEqual([CHILD_B]);
    expect((await listUnits(ports.db)).map((u) => u.id)).toEqual([UNIT_1]);
    expect(await latestPublished(ports.db, UNIT_1)).toBeNull();
    expect((await listChildProgress(ports.db, CHILD_A)).size).toBe(0);
    expect(await ports.db.all('SELECT 1 FROM local_event WHERE child_id = ?', [CHILD_A])).toEqual(
      [],
    );
    expect(await ports.db.all('SELECT 1 FROM outbox WHERE child_id = ?', [CHILD_A])).toEqual([]);
    expect((await listChildProgress(ports.db, CHILD_B)).size).toBe(1);
  });

  it('anchors the trusted clock to the server time of each page', async () => {
    expect(trusted.lastVerifiedAt()).toBeNull();
    ports.clock.advance(5000);
    await engine().syncOnce();
    expect(trusted.lastVerifiedAt()).toBe(ports.clock.now());
    expect(await getMetaNumber(ports.db, META.lastVerifiedAt)).toBe(ports.clock.now());
    expect(trusted.offlineGraceValid()).toBe(true);
  });

  it('creates a TrustedClock itself when none is given', async () => {
    const plain = new SyncEngine({
      ports: { db: ports.db, clock: ports.clock, random: ports.random },
      api: ports.api,
    });
    expect((await plain.syncOnce()).ok).toBe(true);
    expect(await getMetaNumber(ports.db, META.lastVerifiedAt)).toBe(ports.clock.now());
  });
});

describe('pull failures never advance the cursor past unapplied data', () => {
  it('keeps page 1 and its cursor when page 2 fails in transit, then completes', async () => {
    ports.api.failOnCall('pull', 2);
    const e = engine({ pullLimit: 3 });
    const first = await e.syncOnce();
    expect(first).toMatchObject({ ok: false, retryable: true, phase: 'pull' });
    const afterFirst = await getMetaNumber(ports.db, META.lastSyncSeq);
    expect(afterFirst).toBe(3); // page 1 = seq 1..3
    expect(
      (await listChildren(ports.db)).length + (await listSubjects(ports.db)).length,
    ).toBeGreaterThan(0);

    const second = await e.syncOnce();
    expect(second.ok).toBe(true);
    expect(await getMetaNumber(ports.db, META.lastSyncSeq)).toBe(ports.api.currentSyncSeq());
    expect(await listUnits(ports.db)).toHaveLength(2);
  });

  it('rolls the whole page back when applying it fails: no rows, cursor unchanged', async () => {
    let broken = true;
    const flaky = failingDriver(
      ports.db,
      (sql, params) =>
        broken && sql.startsWith('INSERT INTO unit ') && (params?.includes(UNIT_2) ?? false),
    );
    const result = await engine({ db: flaky, pullLimit: 100 }).syncOnce();
    expect(result).toMatchObject({ ok: false, kind: 'internal', phase: 'internal' });
    expect(await getMetaNumber(ports.db, META.lastSyncSeq)).toBeNull();
    expect(await listChildren(ports.db)).toEqual([]);
    expect(await listUnits(ports.db)).toEqual([]);
    expect(await ports.db.get('SELECT * FROM household')).toBeUndefined();

    broken = false;
    expect((await engine({ db: flaky }).syncOnce()).ok).toBe(true);
    expect(await listUnits(ports.db)).toHaveLength(2);
  });

  it('keeps earlier pages when a later page fails to apply', async () => {
    const e = engine({ pullLimit: 3 });
    let failOnce = true;
    const flaky = failingDriver(ports.db, (sql, params) => {
      if (failOnce && sql.startsWith('INSERT INTO unit ') && (params?.includes(UNIT_2) ?? false)) {
        failOnce = false;
        return true;
      }
      return false;
    });
    const result = await engine({ db: flaky, pullLimit: 3 }).syncOnce();
    expect(result.ok).toBe(false);
    const cursor = await getMetaNumber(ports.db, META.lastSyncSeq);
    expect(cursor).toBeGreaterThan(0);
    expect(cursor).toBeLessThan(ports.api.currentSyncSeq());
    expect((await e.syncOnce()).ok).toBe(true);
    expect(await listUnits(ports.db)).toHaveLength(2);
  });

  it('rejects a malformed page as a non-retryable protocol error', async () => {
    vi.spyOn(ports.api, 'pull').mockResolvedValue({ epoch: 'nope' } as unknown as PullResponse);
    const result = await engine().syncOnce();
    expect(result).toMatchObject({
      ok: false,
      retryable: false,
      kind: 'bad_response',
      phase: 'pull',
    });
    expect(await getMetaNumber(ports.db, META.lastSyncSeq)).toBeNull();
  });

  it('does not loop forever on a server that says has_more without advancing', async () => {
    const stuck: PullResponse = {
      epoch: 1,
      next_seq: 0,
      has_more: true,
      server_time: new Date(ports.clock.now()).toISOString(),
      household: null,
      children: [],
      subjects: [],
      units: [],
      published: [],
      unit_progress: [],
    };
    const spy = vi.spyOn(ports.api, 'pull').mockResolvedValue(stuck);
    const result = await engine().syncOnce();
    expect(result).toMatchObject({ ok: false, kind: 'bad_response' });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('reports an expired session as not retryable', async () => {
    ports.api.setAuthExpired(true);
    expect(await engine().syncOnce()).toMatchObject({
      ok: false,
      retryable: false,
      kind: 'unauthenticated',
    });
  });
});

describe('membership epoch', () => {
  it('wipes and re-pulls when access changes, purging revoked children but keeping the rest', async () => {
    const e = engine();
    await e.syncOnce();
    // downloaded packs and unsent work for both children
    await ports.db.run(
      "INSERT INTO pack_file (unit_id, version_no, path, sha256, bytes, kind, pack, state) VALUES (?, 1, 'learner.json', ?, 10, 'content', 'learner', 'verified')",
      [UNIT_1, 'a'.repeat(64)],
    );
    await ports.db.run(
      'INSERT INTO pack_active (unit_id, version_no, activated_at) VALUES (?, 1, 1)',
      [UNIT_1],
    );
    ports.api.rejectEventsWhere((event) => event.event_type === 'section_completed', 'hold');
    await appendEvents(ports, [section(CHILD_A, 'intro'), section(CHILD_B, 'intro')]);
    await e.syncOnce(); // both rows stay queued (poison)
    expect((await outboxCounts(ports.db)).pending).toBe(2);
    await appendEvents(ports, [started(CHILD_B)]);

    ports.api.revokeChild(CHILD_B);
    const result = await e.syncOnce();
    expect(result.ok && result.pull.fullResync).toBe(true);

    expect((await listChildren(ports.db)).map((c) => c.id)).toEqual([CHILD_A]);
    expect(await getMetaNumber(ports.db, META.membershipEpoch)).toBe(ports.api.currentEpoch());
    expect(await getMetaNumber(ports.db, META.lastSyncSeq)).toBe(ports.api.currentSyncSeq());
    // child A's unsent work survives, child B's is gone with the access
    const queued = await ports.db.all<{ child_id: string }>('SELECT child_id FROM outbox');
    expect(queued.map((r) => r.child_id)).toEqual([CHILD_A]);
    expect(await ports.db.all('SELECT 1 FROM local_event WHERE child_id = ?', [CHILD_B])).toEqual(
      [],
    );
    // pack bookkeeping is untouched
    expect(await ports.db.all('SELECT unit_id FROM pack_file')).toEqual([{ unit_id: UNIT_1 }]);
    expect(await ports.db.all('SELECT unit_id FROM pack_active')).toEqual([{ unit_id: UNIT_1 }]);
    // and the pull restarted from the beginning
    expect(ports.api.pullRequests.some((r) => r.sinceSeq === 0)).toBe(true);
  });

  it('does not wipe on the first sync or when the epoch is unchanged', async () => {
    const e = engine();
    const first = await e.syncOnce();
    expect(first.ok && first.pull.fullResync).toBe(false);
    const again = await e.syncOnce();
    expect(again.ok && again.pull.fullResync).toBe(false);
    expect(await listChildren(ports.db)).toHaveLength(2);
  });

  it('treats a different household as a change even when the epoch number is the same', async () => {
    const e = engine();
    await e.syncOnce();
    await appendEvents(ports, [started(CHILD_A)]);
    ports.api.rejectEventsWhere(() => true, 'hold'); // keep the row queued through the sync
    ports.api.setHousehold({ id: '00000000-0000-4000-8000-0000000000f2', name: 'Another family' });
    const result = await e.syncOnce();
    expect(result.ok && result.pull.fullResync).toBe(true);
    expect(await ports.db.get('SELECT id, name FROM household')).toEqual({
      id: '00000000-0000-4000-8000-0000000000f2',
      name: 'Another family',
    });
    // the fake server still lists both children, so they come back; the point is that the wipe happened
    expect(ports.api.pullRequests.filter((r) => r.sinceSeq === 0)).toHaveLength(2);
  });

  it('wipes when the account loses its household', async () => {
    const e = engine();
    await e.syncOnce();
    ports.api.setHousehold(null);
    const result = await e.syncOnce();
    expect(result.ok && result.pull.fullResync).toBe(true);
    expect(await ports.db.get('SELECT * FROM household')).toBeUndefined();
  });

  it('gives up cleanly if the epoch keeps changing', async () => {
    let epoch = 1;
    vi.spyOn(ports.api, 'pull').mockImplementation(() => {
      epoch += 1;
      return Promise.resolve({
        epoch,
        next_seq: 0,
        has_more: false,
        server_time: new Date(ports.clock.now()).toISOString(),
        household: null,
        children: [],
        subjects: [],
        units: [],
        published: [],
        unit_progress: [],
      });
    });
    await engine().syncOnce(); // first epoch is stored
    const result = await engine().syncOnce();
    expect(result).toMatchObject({ ok: false, kind: 'server' });
  });
});

describe('push', () => {
  beforeEach(async () => {
    await engine().syncOnce(); // learn the children first
  });

  it('delivers events and removes them from the outbox, then shows the server-derived progress', async () => {
    await appendEvents(ports, [started(CHILD_A), section(CHILD_A, 'intro'), mastery(CHILD_A, 0.9)]);
    const result = await engine().syncOnce();
    expect(result.ok && result.push).toMatchObject({ sent: 3, delivered: 3, rejected: 0 });
    expect(await outboxCounts(ports.db)).toEqual({ pending: 0, dead: 0 });
    expect(ports.api.acceptedEvents().map((e) => e.device_seq)).toEqual([1, 2, 3]);
    const progress = (await listChildProgress(ports.db, CHILD_A)).get(UNIT_1);
    expect(progress).toMatchObject({
      status: 'mastered',
      attempts: 1,
      mastery_score: 0.9,
      last_section: 'intro',
    });
    const local = await ports.db.all<{ synced_at: number | null }>(
      'SELECT synced_at FROM local_event',
    );
    expect(local.every((row) => row.synced_at !== null)).toBe(true);
  });

  it('sends batches of at most 100, oldest first', async () => {
    const events = Array.from({ length: 250 }, (_, i) => section(CHILD_A, `s_${i}`));
    await appendEvents(ports, events);
    const result = await engine().syncOnce();
    expect(result.ok && result.push.delivered).toBe(250);
    expect(ports.api.pushBatches.map((b) => b.length)).toEqual([100, 100, 50]);
    const seqs = ports.api.pushBatches.flat().map((e) => e.device_seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(seqs[0]).toBe(1);
  });

  it('treats a duplicate as delivered (the server already has it)', async () => {
    await appendEvents(ports, [started(CHILD_A)]);
    ports.api.loseNextPushResponse();
    const lost = await engine().syncOnce();
    expect(lost).toMatchObject({ ok: false, retryable: true, kind: 'offline', phase: 'push' });
    expect(await outboxCounts(ports.db)).toEqual({ pending: 1, dead: 0 });
    expect(ports.api.acceptedEvents()).toHaveLength(1);

    const retried = await engine().syncOnce();
    expect(retried.ok).toBe(true);
    expect(await outboxCounts(ports.db)).toEqual({ pending: 0, dead: 0 });
    expect(ports.api.acceptedEvents()).toHaveLength(1);
  });

  it('leaves everything queued, uncounted, on a transport error', async () => {
    await appendEvents(ports, [started(CHILD_A), started(CHILD_B)]);
    ports.api.setOffline(true);
    const result = await engine().syncOnce();
    expect(result).toMatchObject({ ok: false, retryable: true, kind: 'offline' });
    const rows = await ports.db.all<{ attempts: number; dead: number }>(
      'SELECT attempts, dead FROM outbox',
    );
    expect(rows).toEqual([
      { attempts: 0, dead: 0 },
      { attempts: 0, dead: 0 },
    ]);
    ports.api.setOffline(false);
    expect((await engine().syncOnce()).ok).toBe(true);
    expect(await outboxCounts(ports.db)).toEqual({ pending: 0, dead: 0 });
  });

  it('keeps going when a later batch fails: earlier batches are already delivered', async () => {
    await appendEvents(
      ports,
      Array.from({ length: 150 }, (_, i) => section(CHILD_A, `s_${i}`)),
    );
    ports.api.failOnCall('pushEvents', ports.api.calls.pushEvents + 2);
    const result = await engine().syncOnce();
    expect(result).toMatchObject({ ok: false, retryable: true, phase: 'push' });
    expect(await outboxCounts(ports.db)).toEqual({ pending: 50, dead: 0 });
    expect((await engine().syncOnce()).ok).toBe(true);
    expect(await outboxCounts(ports.db)).toEqual({ pending: 0, dead: 0 });
  });

  it('retries a poison row once per sync, dead-letters it after 5, and never blocks later rows', async () => {
    ports.api.rejectEventsWhere(
      (e) => e.event_type === 'section_completed' && e.payload.section_id === 'bad',
      'invalid_payload',
    );
    await appendEvents(ports, [section(CHILD_A, 'bad'), started(CHILD_A)]);
    const e = engine();

    const first = await e.syncOnce();
    expect(first.ok && first.push).toMatchObject({
      sent: 2,
      delivered: 1,
      rejected: 1,
      deadLettered: 0,
    });
    // the row BEHIND the poison row was delivered on the very first pass
    expect(ports.api.acceptedEvents().map((x) => x.event_type)).toEqual(['unit_started']);
    expect(
      await ports.db.get<{ attempts: number; last_error: string }>(
        'SELECT attempts, last_error FROM outbox',
      ),
    ).toEqual({
      attempts: 1,
      last_error: 'invalid_payload',
    });

    for (let i = 0; i < 3; i += 1) await e.syncOnce();
    expect(await outboxCounts(ports.db)).toEqual({ pending: 1, dead: 0 });
    const fifth = await e.syncOnce();
    expect(fifth.ok && fifth.push.deadLettered).toBe(1);
    expect(await outboxCounts(ports.db)).toEqual({ pending: 0, dead: 1 });

    // a new event after the dead one goes through, and the dead row is not sent again
    const callsBefore = ports.api.calls.pushEvents;
    await appendEvents(ports, [started(CHILD_A, UNIT_2)]);
    await e.syncOnce();
    expect(ports.api.calls.pushEvents).toBe(callsBefore + 1);
    expect(ports.api.pushBatches.at(-1)?.map((x) => x.event_type)).toEqual(['unit_started']);
    await e.syncOnce();
    expect(ports.api.calls.pushEvents).toBe(callsBefore + 1); // nothing live left to send
  });

  it('does not loop within one sync when a row keeps being rejected', async () => {
    ports.api.rejectEventsWhere(() => true, 'nope');
    await appendEvents(ports, [started(CHILD_A)]);
    const before = ports.api.calls.pushEvents;
    await engine().syncOnce();
    expect(ports.api.calls.pushEvents).toBe(before + 1);
  });

  it('counts a missing per-row result as a failed attempt', async () => {
    await appendEvents(ports, [started(CHILD_A)]);
    vi.spyOn(ports.api, 'pushEvents').mockResolvedValue([]);
    await engine().syncOnce();
    expect(await ports.db.get('SELECT attempts, last_error FROM outbox')).toEqual({
      attempts: 1,
      last_error: 'no_result',
    });
  });

  it('dead-letters a corrupt outbox row without sending it', async () => {
    const [event] = await appendEvents(ports, [started(CHILD_A)]);
    await ports.db.run('UPDATE outbox SET payload_json = ? WHERE client_event_id = ?', [
      '{broken',
      event!.client_event_id,
    ]);
    await appendEvents(ports, [started(CHILD_B)]);
    const result = await engine().syncOnce();
    expect(result.ok && result.push).toMatchObject({ sent: 1, delivered: 1, deadLettered: 1 });
    expect(await outboxCounts(ports.db)).toEqual({ pending: 0, dead: 1 });
  });

  it('does not touch dead rows when the push order resumes later', async () => {
    const [a, b] = await appendEvents(ports, [started(CHILD_A), started(CHILD_B)]);
    for (let i = 0; i < 5; i += 1)
      await ports.db.transaction((tx) => markFailed(tx, a!.client_event_id, 'x'));
    expect((await nextBatch(ports.db, 0, 10)).map((x) => x.row.client_event_id)).toEqual([
      b!.client_event_id,
    ]);
  });
});

describe('single flight', () => {
  it('returns the same promise while a sync runs, and runs the API once', async () => {
    const e = engine();
    const first = e.syncOnce();
    const second = e.syncOnce();
    expect(second).toBe(first);
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1).toBe(r2);
    expect(ports.api.calls.pull).toBe(1);

    const third = e.syncOnce();
    expect(third).not.toBe(first);
    await third;
    expect(ports.api.calls.pull).toBe(2);
  });

  it('allows a new sync after a failed one', async () => {
    ports.api.setOffline(true);
    const e = engine();
    expect((await e.syncOnce()).ok).toBe(false);
    ports.api.setOffline(false);
    expect((await e.syncOnce()).ok).toBe(true);
  });
});

describe('device identity', () => {
  it('does not touch the device id or sequence during sync', async () => {
    await appendEvents(ports, [started(CHILD_A)]);
    const id = await getMeta(ports.db, META.deviceId);
    await engine().syncOnce();
    expect(await getMeta(ports.db, META.deviceId)).toBe(id);
    expect(await getMetaNumber(ports.db, META.deviceSeq)).toBe(1);
  });

  it('throws SyncApiError from the fake for coverage of the retryable flag', () => {
    expect(new SyncApiError('offline').retryable).toBe(true);
    expect(new SyncApiError('server').retryable).toBe(true);
    expect(new SyncApiError('unauthenticated').retryable).toBe(false);
    expect(new SyncApiError('bad_response').retryable).toBe(false);
  });
});
