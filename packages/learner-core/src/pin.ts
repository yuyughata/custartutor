import type { SyncApi } from './api';
import { LockedOutError, PinFormatError } from './errors';
import type { Clock, Hasher, Random, SecureKv } from './ports';
import { concatBytes, encodeUtf8, fromHex, toHex } from './utf8';

/**
 * The grown-up PIN gate (ADR 0002).
 *
 * TWO DIFFERENT THINGS, DO NOT CONFUSE THEM:
 *
 *  1. `verifyLocal` is a UI GATE ONLY. It keeps a child out of the grown-ups area on a shared phone while
 *     offline. It protects nothing a determined person with the phone could not get at: the hash lives on
 *     the device. That is acceptable because offline there is no server data to expose beyond the local
 *     cache, and the local cache holds no transcripts (plan section 2). Never treat it as authorisation.
 *  2. `elevate` is the REAL control. The PIN is sent over TLS to the server, which checks it against a bcrypt
 *     hash no client can read, rate-limits and locks out, and only then opens a short elevation that the
 *     server-side RLS/RPCs for sensitive actions require. This class never stores the PIN anywhere.
 *
 * Local hash: `sha256` iterated `rounds` times over (previous digest + salt + device pepper + PIN). The salt is
 * random per PIN; the pepper is a random per-device secret in the secure store. Both live in `SecureKv`
 * (Keystore / Keychain), together with the lockout state.
 */

const PIN_PATTERN = /^\d{4,6}$/;

export const DEFAULT_PIN_ROUNDS = 2000;
/** Consecutive wrong PINs before the first lockout. */
export const LOCKOUT_AFTER_FAILURES = 5;
export const LOCKOUT_BASE_MS = 30_000;
export const LOCKOUT_MAX_MS = 15 * 60_000;

const KEY_HASH = 'pin.hash';
const KEY_PEPPER = 'pin.pepper';
const KEY_LOCK = 'pin.lock';

interface StoredPin {
  v: 1;
  rounds: number;
  salt: string;
  hash: string;
}

interface LockState {
  failures: number;
  lockedUntil: number;
}

export interface PinGateOptions {
  secure: SecureKv;
  hasher: Hasher;
  /** Use the `TrustedClock`: a lockout then survives the clock being turned back. */
  clock: Clock;
  random: Random;
  api: Pick<SyncApi, 'elevateGrownup' | 'setGrownupPin'>;
  /** The installation id sent to `elevate_grownup` (see `getOrCreateDeviceId`). */
  deviceId: () => Promise<string>;
  /** Hash iterations (default 2000). Stored with the hash, so changing it never breaks an existing PIN. */
  rounds?: number;
}

export interface LockStatus {
  locked: boolean;
  /** Milliseconds until the next attempt is allowed (0 when not locked). */
  retryAfterMs: number;
  failures: number;
}

export interface Elevation {
  /** ISO timestamp from the server. */
  expires_at: string;
  expires_at_ms: number;
}

/** Compares two strings without returning early at the first difference. */
export function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/** Lockout length after `failures` consecutive wrong PINs: 30 s, 60 s, 120 s ... capped at 15 minutes. */
export function lockoutDurationMs(failures: number): number {
  if (failures < LOCKOUT_AFTER_FAILURES) return 0;
  const doublings = Math.min(failures - LOCKOUT_AFTER_FAILURES, 16);
  return Math.min(LOCKOUT_BASE_MS * 2 ** doublings, LOCKOUT_MAX_MS);
}

export class PinGate {
  private readonly options: PinGateOptions;
  private readonly rounds: number;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: PinGateOptions) {
    this.options = options;
    this.rounds = options.rounds ?? DEFAULT_PIN_ROUNDS;
  }

  /** Attempts are serialised so parallel guesses cannot slip past the failure counter. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async pepper(): Promise<string> {
    const { secure, random } = this.options;
    const existing = await secure.get(KEY_PEPPER);
    if (existing) return existing;
    const created = toHex(random.bytes(32));
    await secure.set(KEY_PEPPER, created);
    return created;
  }

  private async derive(
    pin: string,
    saltHex: string,
    pepperHex: string,
    rounds: number,
  ): Promise<string> {
    const { hasher } = this.options;
    const tail = concatBytes(fromHex(saltHex), fromHex(pepperHex), encodeUtf8(pin));
    let digest = await hasher.sha256Hex(tail);
    for (let i = 1; i < rounds; i += 1) {
      digest = await hasher.sha256Hex(concatBytes(fromHex(digest), tail));
    }
    return digest;
  }

  private async stored(): Promise<StoredPin | null> {
    const raw = await this.options.secure.get(KEY_HASH);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<StoredPin>;
      if (parsed.v === 1 && typeof parsed.hash === 'string' && typeof parsed.salt === 'string') {
        return {
          v: 1,
          rounds: Number(parsed.rounds) || DEFAULT_PIN_ROUNDS,
          salt: parsed.salt,
          hash: parsed.hash,
        };
      }
    } catch {
      // fall through: a damaged record is the same as no PIN
    }
    return null;
  }

  private async readLock(): Promise<LockState> {
    const raw = await this.options.secure.get(KEY_LOCK);
    if (!raw) return { failures: 0, lockedUntil: 0 };
    try {
      const parsed = JSON.parse(raw) as Partial<LockState>;
      return {
        failures: Number(parsed.failures) || 0,
        lockedUntil: Number(parsed.lockedUntil) || 0,
      };
    } catch {
      return { failures: 0, lockedUntil: 0 };
    }
  }

  private writeLock(state: LockState): Promise<void> {
    return this.options.secure.set(KEY_LOCK, JSON.stringify(state));
  }

  async hasPin(): Promise<boolean> {
    return (await this.stored()) !== null;
  }

  /**
   * Sets or changes the PIN: 4 to 6 digits (`PinFormatError` otherwise).
   *
   * The SERVER goes first (`api.setGrownupPin`): the real control must hold the PIN, and a PIN that exists only
   * on the device would make every later `elevate` fail. So setting a PIN needs a connection; changing an
   * existing one also needs a live elevation (`elevate(oldPin)` first, or use `changePin`). Server errors
   * (`weak_pin`, `elevation_required`, offline) propagate and leave the local PIN as it was.
   */
  async setPin(pin: string): Promise<void> {
    if (!PIN_PATTERN.test(pin)) throw new PinFormatError();
    await this.options.api.setGrownupPin(pin);
    await this.storeLocal(pin);
  }

  /**
   * First launch of a signed-in guardian on a NEW device: the server already holds the household PIN, this
   * device has no local copy yet. Verifies the PIN on the server (`elevate`), and only if that succeeds stores
   * the local hash for the offline UI gate. Does not change the server PIN.
   */
  async adoptServerPin(pin: string): Promise<Elevation> {
    if (!PIN_PATTERN.test(pin)) throw new PinFormatError();
    const elevation = await this.elevate(pin);
    await this.storeLocal(pin);
    return elevation;
  }

  private storeLocal(pin: string): Promise<void> {
    return this.exclusive(async () => {
      const pepper = await this.pepper();
      const salt = toHex(this.options.random.bytes(16));
      const hash = await this.derive(pin, salt, pepper, this.rounds);
      const record: StoredPin = { v: 1, rounds: this.rounds, salt, hash };
      await this.options.secure.set(KEY_HASH, JSON.stringify(record));
      await this.writeLock({ failures: 0, lockedUntil: 0 });
    });
  }

  /** Elevates with the old PIN (server side), then sets the new one. */
  async changePin(oldPin: string, newPin: string): Promise<void> {
    if (!PIN_PATTERN.test(newPin)) throw new PinFormatError();
    await this.elevate(oldPin);
    await this.setPin(newPin);
  }

  /**
   * UI gate (see the class comment): is this the PIN set on this device? Returns false for a wrong PIN, and
   * also when no PIN is set. After 5 consecutive wrong PINs the gate locks for 30 s, then 60 s, 120 s ...
   * up to 15 minutes; while locked it throws `LockedOutError` WITHOUT checking the PIN, so a correct guess
   * during the lock does not help. The counter and lock persist across restarts and use `clock`.
   */
  verifyLocal(pin: string): Promise<boolean> {
    return this.exclusive(async () => {
      const now = this.options.clock.now();
      const lock = await this.readLock();
      if (lock.lockedUntil > now)
        throw new LockedOutError(lock.lockedUntil, lock.lockedUntil - now);

      const stored = await this.stored();
      if (!stored) return false;
      const pepper = await this.pepper();
      const candidate = await this.derive(pin, stored.salt, pepper, stored.rounds);
      if (constantTimeEqual(candidate, stored.hash)) {
        if (lock.failures !== 0 || lock.lockedUntil !== 0) {
          await this.writeLock({ failures: 0, lockedUntil: 0 });
        }
        return true;
      }

      const failures = lock.failures + 1;
      const duration = lockoutDurationMs(failures);
      await this.writeLock({ failures, lockedUntil: duration > 0 ? now + duration : 0 });
      return false;
    });
  }

  /** Current lockout state, for the keypad UI. */
  async lockStatus(): Promise<LockStatus> {
    const lock = await this.readLock();
    const remaining = lock.lockedUntil - this.options.clock.now();
    return { locked: remaining > 0, retryAfterMs: Math.max(0, remaining), failures: lock.failures };
  }

  /**
   * The real elevation: sends the PIN to the server (`elevate_grownup`) and returns when the elevation ends. The
   * server throws `SyncApiError('invalid_pin')` for a wrong PIN or a server-side lockout. The PIN is not
   * kept: nothing here writes it anywhere.
   */
  async elevate(pin: string): Promise<Elevation> {
    const deviceId = await this.options.deviceId();
    const { expires_at: expiresAt } = await this.options.api.elevateGrownup(deviceId, pin);
    return { expires_at: expiresAt, expires_at_ms: Date.parse(expiresAt) };
  }

  /** Forgets the local PIN, pepper and lockout (sign-out). */
  async clear(): Promise<void> {
    const { secure } = this.options;
    await secure.delete(KEY_HASH);
    await secure.delete(KEY_PEPPER);
    await secure.delete(KEY_LOCK);
  }
}
