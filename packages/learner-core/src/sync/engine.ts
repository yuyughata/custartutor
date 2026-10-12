import type { SyncApi, SyncApiError } from '../api';
import { TrustedClock } from '../clock';
import { pruneSyncedEvents } from '../db/events';
import type { Ports } from '../ports';
import { pullAll } from './pull';
import { pushOutbox } from './push';
import { emptyPull, emptyPush } from './result';
import type { SyncResult } from './result';

export interface SyncEngineOptions {
  ports: Pick<Ports, 'db' | 'clock' | 'random'>;
  api: SyncApi;
  /**
   * The trusted clock to anchor to the server. Defaults to `ports.clock` when that already is one, otherwise
   * one is created over `ports.clock` on first use.
   */
  trustedClock?: TrustedClock;
  /** Rows per pull page (default 200). */
  pullLimit?: number;
}

/** Synced events are kept this long in `local_event` for the local log, then pruned. */
const KEEP_SYNCED_EVENTS_MS = 30 * 24 * 3_600_000;

/**
 * `syncOnce()` = push, then pull. It never throws: failures come back as `{ ok: false, retryable, ... }`
 * with every unsent event still queued. Concurrent calls share one run (single-flight): while a sync is in
 * progress, `syncOnce()` returns the same promise.
 */
export class SyncEngine {
  private readonly ports: SyncEngineOptions['ports'];
  private readonly api: SyncApi;
  private readonly pullLimit?: number;
  private trusted: Promise<TrustedClock> | null;
  private inflight: Promise<SyncResult> | null = null;

  constructor(options: SyncEngineOptions) {
    this.ports = options.ports;
    this.api = options.api;
    if (options.pullLimit !== undefined) this.pullLimit = options.pullLimit;
    const given =
      options.trustedClock ??
      (options.ports.clock instanceof TrustedClock ? options.ports.clock : undefined);
    this.trusted = given ? Promise.resolve(given) : null;
  }

  private trustedClock(): Promise<TrustedClock> {
    this.trusted ??= TrustedClock.create(this.ports.db, this.ports.clock);
    return this.trusted;
  }

  syncOnce(): Promise<SyncResult> {
    if (this.inflight) return this.inflight;
    const run = this.run().finally(() => {
      this.inflight = null;
    });
    this.inflight = run;
    return run;
  }

  private async run(): Promise<SyncResult> {
    const push = emptyPush();
    const pull = emptyPull();
    try {
      const clock = await this.trustedClock();
      const { db } = this.ports;

      const pushed = await pushOutbox({ db, clock, api: this.api });
      Object.assign(push, pushed.report);
      if (!pushed.ok) return this.failure(pushed.error, 'push', push, pull);

      const pulled = await pullAll({
        db,
        api: this.api,
        clock,
        ...(this.pullLimit !== undefined ? { pullLimit: this.pullLimit } : {}),
      });
      Object.assign(pull, pulled.report);
      if (!pulled.ok) return this.failure(pulled.error, 'pull', push, pull);

      await pruneSyncedEvents(db, clock.now() - KEEP_SYNCED_EVENTS_MS);
      await clock.checkpoint(true);
      return { ok: true, push, pull };
    } catch (error) {
      return {
        ok: false,
        retryable: false,
        kind: 'internal',
        message: error instanceof Error ? error.message : String(error),
        phase: 'internal',
        push,
        pull,
      };
    }
  }

  private failure(
    error: SyncApiError,
    phase: 'push' | 'pull',
    push: SyncResult['push'],
    pull: SyncResult['pull'],
  ): SyncResult {
    return {
      ok: false,
      retryable: error.retryable,
      kind: error.code,
      message: error.message,
      phase,
      push,
      pull,
    };
  }
}
