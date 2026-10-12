import { beforeEach, describe, expect, it } from 'vitest';
import { SyncApiError } from './api';
import { getOrCreateDeviceId } from './db/meta';
import { LockedOutError, PinFormatError } from './errors';
import { LOCKOUT_MAX_MS, PinGate, constantTimeEqual, lockoutDurationMs } from './pin';
import type { PinGateOptions } from './pin';
import type { Hasher } from './ports';
import { createTestPorts, createTrustedClock } from './testing';
import type { TestPorts } from './testing';

let ports: TestPorts;
let hashCalls: number;
let gate: PinGate;

function newGate(over: Partial<PinGateOptions> = {}): PinGate {
  const counting: Hasher = {
    sha256Hex: (bytes) => {
      hashCalls += 1;
      return ports.hasher.sha256Hex(bytes);
    },
    sha256FileHex: (path) => ports.hasher.sha256FileHex(path),
  };
  return new PinGate({
    secure: ports.secure,
    hasher: counting,
    clock: ports.clock,
    random: ports.random,
    api: ports.api,
    deviceId: () => getOrCreateDeviceId(ports.db, ports.random),
    rounds: 50, // fast tests; the default is checked separately
    ...over,
  });
}

beforeEach(async () => {
  ports = await createTestPorts({ seed: 'pin' });
  hashCalls = 0;
  gate = newGate();
});

describe('setPin', () => {
  it('rejects anything but 4 to 6 digits, without calling the server', async () => {
    for (const bad of ['123', '1234567', 'abcd', '12a4', '', '12 34', '\uff11\uff12\uff13\uff14']) {
      await expect(gate.setPin(bad), bad).rejects.toBeInstanceOf(PinFormatError);
    }
    expect(ports.api.calls.setGrownupPin).toBe(0);
    expect(await gate.hasPin()).toBe(false);
  });

  it.each(['2468', '24680', '246802'])('accepts the PIN %s', async (pin) => {
    await gate.setPin(pin);
    expect(await gate.hasPin()).toBe(true);
    expect(await gate.verifyLocal(pin)).toBe(true);
  });

  it('tells the server first, then stores a salted hash and a device pepper', async () => {
    await gate.setPin('2468');
    expect(ports.api.hasPin()).toBe(true);
    const dump = ports.secure.dump();
    expect(Object.keys(dump).sort()).toEqual(['pin.hash', 'pin.lock', 'pin.pepper']);
    expect(JSON.stringify(dump)).not.toContain('2468');
    const record = JSON.parse(dump['pin.hash'] ?? '{}') as {
      salt: string;
      hash: string;
      rounds: number;
    };
    expect(record.rounds).toBe(50);
    expect(record.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(record.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(dump['pin.pepper']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('uses a fresh salt each time but keeps one pepper per device', async () => {
    await gate.setPin('2468');
    const first = ports.secure.dump();
    ports.api.seedPin('2468'); // pretend elevation succeeded
    await ports.api.elevateGrownup('d', '2468');
    await gate.setPin('2468');
    const second = ports.secure.dump();
    expect(second['pin.pepper']).toBe(first['pin.pepper']);
    expect(second['pin.hash']).not.toBe(first['pin.hash']);
  });

  it('leaves the local PIN alone when the server refuses', async () => {
    await expect(gate.setPin('1234')).rejects.toMatchObject({ code: 'weak_pin' });
    expect(await gate.hasPin()).toBe(false);
    ports.api.setOffline(true);
    await expect(gate.setPin('2468')).rejects.toMatchObject({ code: 'offline' });
    expect(await gate.hasPin()).toBe(false);
    expect(ports.secure.dump()).toEqual({});
  });

  it('requires an elevation to change an existing PIN, then replaces it everywhere', async () => {
    await gate.setPin('2468');
    await expect(gate.setPin('1357')).rejects.toMatchObject({ code: 'elevation_required' });
    expect(await gate.verifyLocal('2468')).toBe(true);

    await gate.changePin('2468', '1357');
    expect(await gate.verifyLocal('1357')).toBe(true);
    expect(await gate.verifyLocal('2468')).toBe(false);
    await expect(gate.changePin('9999', '1470')).rejects.toBeInstanceOf(SyncApiError);
  });
});

describe('verifyLocal', () => {
  it('accepts the right PIN and rejects a wrong one', async () => {
    await gate.setPin('2468');
    expect(await gate.verifyLocal('2468')).toBe(true);
    expect(await gate.verifyLocal('2469')).toBe(false);
    expect(await gate.verifyLocal('')).toBe(false);
    expect(await gate.verifyLocal('2468')).toBe(true);
  });

  it('returns false (and does not count) when no PIN is set', async () => {
    expect(await gate.verifyLocal('2468')).toBe(false);
    expect((await gate.lockStatus()).failures).toBe(0);
  });

  it('iterates the hash `rounds` times and the default is 2000', async () => {
    await gate.setPin('2468');
    hashCalls = 0;
    await gate.verifyLocal('2468');
    expect(hashCalls).toBe(50);

    const defaults = newGate({ rounds: undefined });
    ports.api.seedPin('2468');
    await ports.api.elevateGrownup('d', '2468');
    await defaults.setPin('2468');
    hashCalls = 0;
    await defaults.verifyLocal('2468');
    expect(hashCalls).toBe(2000);
  });

  it('keeps verifying an older PIN after the configured round count changes', async () => {
    await gate.setPin('2468');
    const other = newGate({ rounds: 7 });
    expect(await other.verifyLocal('2468')).toBe(true);
  });

  it('never stores the PIN in any form that contains it', async () => {
    await gate.setPin('2468');
    await gate.verifyLocal('2468');
    await gate.verifyLocal('0000');
    expect(JSON.stringify(ports.secure.dump())).not.toMatch(/2468|0000/);
  });
});

describe('lockout', () => {
  async function failTimes(n: number): Promise<void> {
    for (let i = 0; i < n; i += 1) expect(await gate.verifyLocal('0000')).toBe(false);
  }

  beforeEach(async () => {
    await gate.setPin('2468');
  });

  it('allows four wrong tries, locks on the fifth for 30 seconds', async () => {
    await failTimes(4);
    expect((await gate.lockStatus()).locked).toBe(false);
    expect(await gate.verifyLocal('0000')).toBe(false); // the 5th wrong PIN
    expect(await gate.lockStatus()).toMatchObject({
      locked: true,
      retryAfterMs: 30_000,
      failures: 5,
    });

    const error = await gate.verifyLocal('0000').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LockedOutError);
    expect(error).toMatchObject({ retryAfterMs: 30_000, lockedUntil: ports.clock.now() + 30_000 });
  });

  it('does not check the PIN while locked, so a correct guess does not help', async () => {
    await failTimes(5);
    await expect(gate.verifyLocal('2468')).rejects.toBeInstanceOf(LockedOutError);
    ports.clock.advance(29_999);
    await expect(gate.verifyLocal('2468')).rejects.toBeInstanceOf(LockedOutError);
    ports.clock.advance(1);
    expect(await gate.verifyLocal('2468')).toBe(true);
  });

  it('backs off exponentially: 30 s, 60 s, 120 s ... capped at 15 minutes', async () => {
    await failTimes(5);
    const waits: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      const status = await gate.lockStatus();
      waits.push(status.retryAfterMs);
      ports.clock.advance(status.retryAfterMs);
      expect(await gate.verifyLocal('0000')).toBe(false);
    }
    expect(waits).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000, 900_000]);
    expect(LOCKOUT_MAX_MS).toBe(900_000);
  });

  it('resets after a correct PIN', async () => {
    await failTimes(5);
    ports.clock.advance(30_000);
    expect(await gate.verifyLocal('2468')).toBe(true);
    expect(await gate.lockStatus()).toMatchObject({ locked: false, failures: 0 });
    await failTimes(4);
    expect((await gate.lockStatus()).locked).toBe(false);
  });

  it('counts consecutive failures only: a success in between resets the count', async () => {
    await failTimes(4);
    expect(await gate.verifyLocal('2468')).toBe(true);
    await failTimes(4);
    expect((await gate.lockStatus()).locked).toBe(false);
  });

  it('survives a restart (state is in the secure store)', async () => {
    await failTimes(5);
    const reborn = newGate();
    await expect(reborn.verifyLocal('2468')).rejects.toBeInstanceOf(LockedOutError);
    expect((await reborn.lockStatus()).locked).toBe(true);
  });

  it('cannot be shortened by turning the clock back when the TrustedClock is used', async () => {
    const trusted = await createTrustedClock(ports);
    const strict = newGate({ clock: trusted });
    await strict.verifyLocal('0000');
    for (let i = 0; i < 4; i += 1) await strict.verifyLocal('0000');
    expect((await strict.lockStatus()).retryAfterMs).toBe(30_000);
    ports.clock.advance(-10 * 60_000); // wind the phone's clock back ten minutes
    // 'now' does not fall below what was seen, so the remaining wait is not extended or reset
    const status = await strict.lockStatus();
    expect(status.locked).toBe(true);
    expect(status.retryAfterMs).toBeLessThanOrEqual(30_000);
    await expect(strict.verifyLocal('2468')).rejects.toBeInstanceOf(LockedOutError);
  });

  it('serialises parallel guesses so they cannot outrun the counter', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 9 }, () => gate.verifyLocal('0000')),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(4);
    expect(rejected.every((r) => r.reason instanceof LockedOutError)).toBe(true);
  });

  it('exposes the back-off formula', () => {
    expect([4, 5, 6, 7, 10, 11, 12, 30].map(lockoutDurationMs)).toEqual([
      0, 30_000, 60_000, 120_000, 900_000, 900_000, 900_000, 900_000,
    ]);
  });
});

describe('elevate (server side)', () => {
  it('sends the PIN and the device id to the server and returns the expiry', async () => {
    await gate.setPin('2468');
    const elevation = await gate.elevate('2468');
    const deviceId = await getOrCreateDeviceId(ports.db, ports.random);
    expect(ports.api.elevations).toEqual([{ deviceId, at: ports.clock.now() }]);
    expect(elevation.expires_at_ms).toBe(ports.clock.now() + 10 * 60_000);
    expect(new Date(elevation.expires_at).getTime()).toBe(elevation.expires_at_ms);
  });

  it('never stores the PIN, even after a successful elevation', async () => {
    await gate.setPin('2468');
    const before = JSON.stringify(ports.secure.dump());
    await gate.elevate('2468');
    expect(JSON.stringify(ports.secure.dump())).toBe(before);
    expect(JSON.stringify(ports.secure.dump())).not.toContain('2468');
  });

  it('surfaces a wrong PIN and the server lockout as invalid_pin', async () => {
    await gate.setPin('2468');
    for (let i = 0; i < 5; i += 1) {
      await expect(gate.elevate('0000')).rejects.toMatchObject({ code: 'invalid_pin' });
    }
    // locked on the server: even the right PIN is refused
    await expect(gate.elevate('2468')).rejects.toMatchObject({ code: 'invalid_pin' });
    ports.clock.advance(31_000);
    await expect(gate.elevate('2468')).resolves.toBeDefined();
  });

  it('is independent of the local gate: a local lockout does not block it, and vice versa', async () => {
    await gate.setPin('2468');
    for (let i = 0; i < 5; i += 1) await gate.verifyLocal('0000');
    await expect(gate.elevate('2468')).resolves.toBeDefined();
  });

  it('propagates offline errors', async () => {
    await gate.setPin('2468');
    ports.api.setOffline(true);
    await expect(gate.elevate('2468')).rejects.toMatchObject({ code: 'offline' });
  });
});

describe('adoptServerPin (a new device for a guardian who already has a PIN)', () => {
  it('verifies on the server, then enables the local gate without changing the server PIN', async () => {
    ports.api.seedPin('2468');
    expect(await gate.hasPin()).toBe(false);
    const elevation = await gate.adoptServerPin('2468');
    expect(elevation.expires_at_ms).toBeGreaterThan(ports.clock.now());
    expect(ports.api.calls.setGrownupPin).toBe(0);
    expect(await gate.verifyLocal('2468')).toBe(true);
    expect(await gate.verifyLocal('1357')).toBe(false);
  });

  it('stores nothing when the server says the PIN is wrong', async () => {
    ports.api.seedPin('2468');
    await expect(gate.adoptServerPin('1357')).rejects.toMatchObject({ code: 'invalid_pin' });
    expect(await gate.hasPin()).toBe(false);
    expect(ports.secure.dump()).toEqual({});
    await expect(gate.adoptServerPin('12')).rejects.toBeInstanceOf(PinFormatError);
  });
});

describe('clear', () => {
  it('forgets the local PIN, pepper and lock', async () => {
    await gate.setPin('2468');
    await gate.verifyLocal('0000');
    await gate.clear();
    expect(ports.secure.dump()).toEqual({});
    expect(await gate.hasPin()).toBe(false);
  });
});

describe('constantTimeEqual', () => {
  it('compares whole strings', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
  });
});
