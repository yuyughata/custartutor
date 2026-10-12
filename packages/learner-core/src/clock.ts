import { META, getMetaNumber, setMetaNumber } from './db/meta';
import type { Clock, SqlDriver } from './ports';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** The device clock may be set back by this much before we call it a rollback (DST glitches, manual nudges). */
export const ROLLBACK_TOLERANCE_MS = 24 * HOUR_MS;
/** How long a device stays trusted after its last successful server contact (ADR 0002; tunable). */
export const DEFAULT_GRACE_DAYS = 30;
/** `checkpoint()` writes `max_seen_time` at most this often unless forced. */
const PERSIST_STEP_MS = 60_000;

/**
 * A clock that wraps the (untrusted) device clock with two defences from ADR 0002:
 *
 *  1. MONOTONIC: `now()` never goes backwards. The highest time ever returned (`max_seen_time`) is persisted
 *     in `meta`, so turning the phone's clock back, even across app restarts, cannot make events older or
 *     shorten a PIN lockout.
 *  2. SERVER ANCHORED: `anchor(serverTime)` records the last time the server vouched for this device
 *     (`last_verified_at`) and the device/server offset. `offlineGraceValid()` then says whether the device
 *     is still inside the offline grace window.
 *
 * POLICY: an invalid grace blocks SYNC and NEW DOWNLOADS (the app asks the user to sign in / reconnect:
 * `needsReverification()`), but it NEVER blocks playback of lessons already on the device:
 * `canPlayOffline()` is always true. A child must not lose their lesson because the phone was offline.
 *
 * Grace is measured on the device clock between the anchor and now, so a phone whose clock is simply wrong
 * (but steady) works. Rolling the clock back by more than 24 h below the highest time seen invalidates it
 * until the next successful sync re-anchors (which also re-bases `max_seen_time`, so a one-off forward
 * skew can never poison the clock forever).
 *
 * Use it as `ports.clock` so events and lockouts are monotonic. Call `checkpoint()` at start-up, when the app
 * goes to the background and after each sync (the sync engine does the last one).
 */
export class TrustedClock implements Clock {
  private maxSeen: number;
  private persistedMaxSeen: number;
  private lastVerified: number | null;
  private offsetMs: number | null;

  private constructor(
    private readonly db: SqlDriver,
    private readonly device: Clock,
    state: { maxSeen: number; lastVerified: number | null; offsetMs: number | null },
  ) {
    this.maxSeen = state.maxSeen;
    this.persistedMaxSeen = state.maxSeen;
    this.lastVerified = state.lastVerified;
    this.offsetMs = state.offsetMs;
  }

  /** Loads the persisted state. Run the migrations first. */
  static async create(db: SqlDriver, device: Clock): Promise<TrustedClock> {
    const [maxSeen, lastVerified, offsetMs] = await Promise.all([
      getMetaNumber(db, META.maxSeenTime),
      getMetaNumber(db, META.lastVerifiedAt),
      getMetaNumber(db, META.serverOffsetMs),
    ]);
    return new TrustedClock(db, device, { maxSeen: maxSeen ?? 0, lastVerified, offsetMs });
  }

  /** Milliseconds since the epoch: the device time, but never earlier than anything returned before. */
  now(): number {
    const current = Math.max(this.device.now(), this.maxSeen);
    this.maxSeen = current;
    return current;
  }

  /** Persists `max_seen_time` when it moved by a minute or more (always when `force`). */
  async checkpoint(force = false): Promise<void> {
    const current = this.now();
    if (!force && current - this.persistedMaxSeen < PERSIST_STEP_MS) return;
    await setMetaNumber(this.db, META.maxSeenTime, current);
    this.persistedMaxSeen = current;
  }

  /**
   * Records a server-vouched moment. `serverTimeIso` is the `server_time` of a successful pull. Also
   * re-bases `max_seen_time` to the current device time: the server just confirmed this device's clock
   * relationship, so any earlier skew is forgiven.
   */
  async anchor(serverTimeIso: string): Promise<void> {
    const serverMs = Date.parse(serverTimeIso);
    if (Number.isNaN(serverMs)) throw new Error(`Invalid server time: ${serverTimeIso}`);
    const deviceMs = this.device.now();
    await this.db.transaction(async (tx) => {
      await setMetaNumber(tx, META.lastVerifiedAt, serverMs);
      await setMetaNumber(tx, META.serverOffsetMs, serverMs - deviceMs);
      await setMetaNumber(tx, META.maxSeenTime, deviceMs);
    });
    this.lastVerified = serverMs;
    this.offsetMs = serverMs - deviceMs;
    this.maxSeen = deviceMs;
    this.persistedMaxSeen = deviceMs;
  }

  /** Server time of the last successful sync (epoch ms), or null if the device was never verified. */
  lastVerifiedAt(): number | null {
    return this.lastVerified;
  }

  /** Our best estimate of the real time: the device time corrected by the last measured offset. */
  estimatedServerNow(): number {
    return this.device.now() + (this.offsetMs ?? 0);
  }

  /** How far the device clock is below the highest time seen (0 when it is not behind). */
  rollbackMs(): number {
    return Math.max(0, this.maxSeen - this.device.now());
  }

  /** Milliseconds left of the grace window, or 0 when it is invalid or over. */
  graceRemainingMs(graceDays: number = DEFAULT_GRACE_DAYS): number {
    if (this.lastVerified === null) return 0;
    if (this.rollbackMs() > ROLLBACK_TOLERANCE_MS) return 0;
    const anchorOnDevice = this.lastVerified - (this.offsetMs ?? 0);
    const elapsed = this.device.now() - anchorOnDevice;
    if (elapsed < -ROLLBACK_TOLERANCE_MS) return 0; // clock set to before the last verification
    return Math.max(0, graceDays * DAY_MS - elapsed);
  }

  /**
   * True while the device may be trusted offline: it was verified at some point, the clock has not been rolled
   * back by more than 24 h, and no more than `graceDays` have passed since the last verification.
   */
  offlineGraceValid(graceDays: number = DEFAULT_GRACE_DAYS): boolean {
    return this.graceRemainingMs(graceDays) > 0;
  }

  /** Playback of downloaded lessons is never blocked by the grace window. Always true. */
  canPlayOffline(): true {
    return true;
  }

  /** The UI should ask the user to reconnect and sign in again (sync and new downloads need it). */
  needsReverification(graceDays: number = DEFAULT_GRACE_DAYS): boolean {
    return !this.offlineGraceValid(graceDays);
  }
}
