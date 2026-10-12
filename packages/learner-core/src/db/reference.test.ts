import { beforeEach, describe, expect, it } from 'vitest';
import { SyncEngine } from '../sync/engine';
import { CHILD_A, UNIT_1 } from '../test-helpers';
import { createTestPorts, createTrustedClock } from '../testing';
import type { TestPorts } from '../testing';
import { appendEvents } from './events';
import { META, getMeta, getMetaNumber } from './meta';
import { listChildren, listSubjects, listUnits, purgeAccountData } from './reference';

let ports: TestPorts;

beforeEach(async () => {
  ports = await createTestPorts({ seed: 'reference' });
  ports.api.setHousehold({ id: '00000000-0000-4000-8000-0000000000f1', name: 'Family' });
  ports.api.addChild({
    id: CHILD_A,
    household_id: '00000000-0000-4000-8000-0000000000f1',
    display_alias: 'Ada',
    avatar: null,
    level_code: 'P1',
    reading_mode: 'reader',
    daily_limit_min: null,
  });
});

describe('purgeAccountData (sign-out)', () => {
  it('removes everything about the account but keeps the installation and the packs', async () => {
    const trusted = await createTrustedClock(ports);
    const engine = new SyncEngine({ ports, api: ports.api, trustedClock: trusted });
    await engine.syncOnce();
    await appendEvents(ports, [
      {
        child_id: CHILD_A,
        unit_id: UNIT_1,
        occurred_at: new Date(ports.clock.now()).toISOString(),
        event_type: 'unit_started',
        payload: {},
      },
    ]);
    await ports.db.run(
      'INSERT INTO pack_active (unit_id, version_no, activated_at) VALUES (?, 1, 1)',
      [UNIT_1],
    );
    const deviceId = await getMeta(ports.db, META.deviceId);
    expect(await listChildren(ports.db)).toHaveLength(1);

    await purgeAccountData(ports.db);

    expect(await listChildren(ports.db)).toEqual([]);
    expect(await listSubjects(ports.db)).toEqual([]);
    expect(await listUnits(ports.db)).toEqual([]);
    for (const table of ['household', 'unit_progress', 'outbox', 'local_event']) {
      expect(await ports.db.all(`SELECT * FROM ${table}`), table).toEqual([]);
    }
    expect(await getMetaNumber(ports.db, META.lastSyncSeq)).toBeNull();
    expect(await getMetaNumber(ports.db, META.membershipEpoch)).toBeNull();
    expect(await getMetaNumber(ports.db, META.lastVerifiedAt)).toBeNull();
    expect(await getMeta(ports.db, META.deviceId)).toBe(deviceId);
    expect(await getMetaNumber(ports.db, META.deviceSeq)).toBe(1);
    expect(await ports.db.all('SELECT unit_id FROM pack_active')).toEqual([{ unit_id: UNIT_1 }]);

    // a fresh sign-in starts from scratch
    const again = await new SyncEngine({ ports, api: ports.api }).syncOnce();
    expect(again.ok && again.pull.fullResync).toBe(false);
    expect(await listChildren(ports.db)).toHaveLength(1);
  });
});
