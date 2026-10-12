import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_GRACE_DAYS, ROLLBACK_TOLERANCE_MS, TrustedClock } from './clock';
import { migrate } from './db/migrate';
import { META, getMetaNumber } from './db/meta';
import { ManualClock } from './fakes/manual-clock';
import { NodeSqliteDriver } from './testing/node-sqlite-driver';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let db: NodeSqliteDriver;
let device: ManualClock;
let clock: TrustedClock;

beforeEach(async () => {
  db = new NodeSqliteDriver();
  await migrate(db);
  device = new ManualClock(Date.UTC(2026, 9, 12, 8, 0, 0));
  clock = await TrustedClock.create(db, device);
});

describe('TrustedClock monotonic time', () => {
  it('follows the device clock forward', () => {
    const start = clock.now();
    device.advance(5000);
    expect(clock.now()).toBe(start + 5000);
  });

  it('never goes backwards when the device clock is set back', () => {
    const t1 = clock.now();
    device.advance(HOUR);
    const t2 = clock.now();
    device.set(t1 - DAY);
    expect(clock.now()).toBe(t2);
    device.set(t2 + 10);
    expect(clock.now()).toBe(t2 + 10);
  });

  it('persists max_seen_time and honours it after a restart', async () => {
    device.advance(2 * HOUR);
    const seen = clock.now();
    await clock.checkpoint();
    expect(await getMetaNumber(db, META.maxSeenTime)).toBe(seen);

    device.set(seen - 3 * DAY); // phone clock rolled back, app restarted
    const reborn = await TrustedClock.create(db, device);
    expect(reborn.now()).toBe(seen);
    expect(reborn.rollbackMs()).toBeGreaterThan(2 * DAY);
  });

  it('throttles checkpoint writes unless forced', async () => {
    await clock.checkpoint(true);
    const first = await getMetaNumber(db, META.maxSeenTime);
    device.advance(1000);
    await clock.checkpoint();
    expect(await getMetaNumber(db, META.maxSeenTime)).toBe(first);
    await clock.checkpoint(true);
    expect(await getMetaNumber(db, META.maxSeenTime)).toBe(first! + 1000);
  });
});

describe('TrustedClock server anchor and offline grace', () => {
  it('is not valid before the first verification, but playback is always allowed', () => {
    expect(clock.offlineGraceValid()).toBe(false);
    expect(clock.needsReverification()).toBe(true);
    expect(clock.canPlayOffline()).toBe(true);
    expect(clock.lastVerifiedAt()).toBeNull();
  });

  it('records last_verified_at and the offset when anchored', async () => {
    const serverMs = device.now() + 90_000; // device is 90 s behind the server
    await clock.anchor(new Date(serverMs).toISOString());
    expect(clock.lastVerifiedAt()).toBe(serverMs);
    expect(await getMetaNumber(db, META.lastVerifiedAt)).toBe(serverMs);
    expect(await getMetaNumber(db, META.serverOffsetMs)).toBe(90_000);
    expect(clock.estimatedServerNow()).toBe(serverMs);
    expect(clock.offlineGraceValid()).toBe(true);
  });

  it('stays valid for 30 days and then expires', async () => {
    await clock.anchor(new Date(device.now()).toISOString());
    device.advance(29 * DAY);
    expect(clock.offlineGraceValid()).toBe(true);
    expect(clock.graceRemainingMs()).toBeLessThanOrEqual(DAY);
    device.advance(2 * DAY);
    expect(clock.offlineGraceValid()).toBe(false);
    expect(clock.needsReverification()).toBe(true);
    expect(clock.canPlayOffline()).toBe(true);
  });

  it('honours a custom window', async () => {
    await clock.anchor(new Date(device.now()).toISOString());
    device.advance(8 * DAY);
    expect(clock.offlineGraceValid(7)).toBe(false);
    expect(clock.offlineGraceValid(14)).toBe(true);
    expect(DEFAULT_GRACE_DAYS).toBe(30);
  });

  it('tolerates a small rollback but not one beyond 24 hours', async () => {
    await clock.anchor(new Date(device.now()).toISOString());
    device.advance(3 * DAY);
    clock.now(); // the app saw this time
    device.advance(-(ROLLBACK_TOLERANCE_MS - HOUR));
    expect(clock.offlineGraceValid()).toBe(true);
    device.advance(-2 * HOUR);
    expect(clock.rollbackMs()).toBeGreaterThan(ROLLBACK_TOLERANCE_MS);
    expect(clock.offlineGraceValid()).toBe(false);
  });

  it('detects a rollback that survives a restart', async () => {
    await clock.anchor(new Date(device.now()).toISOString());
    device.advance(10 * DAY);
    await clock.checkpoint(true);
    device.set(device.now() - 9 * DAY); // cheat: wind the clock back to extend the window
    const reborn = await TrustedClock.create(db, device);
    expect(reborn.offlineGraceValid()).toBe(false);
  });

  it('forgives a clock that is wrong but steady', async () => {
    device.set(Date.UTC(2031, 0, 1)); // phone thinks it is 2031
    const trueServerMs = Date.UTC(2026, 9, 12, 8, 0, 0);
    await clock.anchor(new Date(trueServerMs).toISOString());
    expect(clock.offlineGraceValid()).toBe(true);
    device.advance(10 * DAY);
    expect(clock.offlineGraceValid()).toBe(true);
  });

  it('re-anchoring after a forward skew re-bases max_seen_time (no permanent poisoning)', async () => {
    device.set(Date.UTC(2030, 0, 1));
    await clock.checkpoint(true);
    device.set(Date.UTC(2026, 9, 12, 9, 0, 0)); // fixed the clock, but max_seen says 2030
    expect(clock.rollbackMs()).toBeGreaterThan(DAY);
    await clock.anchor(new Date(device.now()).toISOString());
    expect(clock.rollbackMs()).toBe(0);
    expect(clock.now()).toBe(device.now());
    expect(clock.offlineGraceValid()).toBe(true);
  });

  it('rejects a garbage server time', async () => {
    await expect(clock.anchor('not a date')).rejects.toThrow(/Invalid server time/);
  });
});
