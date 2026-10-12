import { SyncApiError, toSyncApiError } from '../api';
import type { SyncApi } from '../api';
import { markDead, markDelivered, markFailed, nextBatch } from '../db/outbox';
import type { Clock, SqlDriver } from '../ports';
import { MAX_PUSH_BATCH, PushResults } from '../wire';
import type { PushResult } from '../wire';
import { emptyPush } from './result';
import type { PushReport } from './result';

export interface PushDeps {
  db: SqlDriver;
  clock: Clock;
  api: SyncApi;
}

export type PushOutcome =
  { ok: true; report: PushReport } | { ok: false; error: SyncApiError; report: PushReport };

/**
 * PUSH: sends the outbox oldest-first (by `device_seq`) in batches of at most 100.
 *
 *  - accepted / duplicate: the row is deleted from the outbox (and stamped on the local log);
 *  - rejected, or no result for the row: the attempt counter goes up and the reason is stored; at 5
 *    attempts the row is dead-lettered and never selected again. Because every batch is built from rows after
 *    the last one handled, a stubborn row is retried once per sync and can never block the rows behind it;
 *  - a transport or server error leaves ALL unsent rows exactly as they were (nothing is counted against
 *    them) and is returned, not thrown.
 */
export async function pushOutbox(deps: PushDeps): Promise<PushOutcome> {
  const { db, clock, api } = deps;
  const report = emptyPush();
  let after = 0;

  for (;;) {
    const entries = await nextBatch(db, after, MAX_PUSH_BATCH);
    if (entries.length === 0) return { ok: true, report };
    after = entries[entries.length - 1]?.row.device_seq ?? after;

    const sendable = entries.flatMap((entry) => (entry.event ? [entry.event] : []));
    for (const entry of entries) {
      if (!entry.event) {
        await markDead(db, entry.row.client_event_id, 'corrupt outbox row');
        report.deadLettered += 1;
      }
    }
    if (sendable.length === 0) continue;

    let results: PushResult[];
    try {
      const raw = await api.pushEvents(sendable);
      const parsed = PushResults.safeParse(raw);
      if (!parsed.success) throw new SyncApiError('bad_response', 'Malformed push response');
      results = parsed.data;
    } catch (error) {
      return { ok: false, error: toSyncApiError(error), report };
    }

    report.sent += sendable.length;
    const byId = new Map(results.map((result) => [result.client_event_id, result]));
    const delivered: string[] = [];
    await db.transaction(async (tx) => {
      for (const event of sendable) {
        const result = byId.get(event.client_event_id);
        if (result && (result.status === 'accepted' || result.status === 'duplicate')) {
          delivered.push(event.client_event_id);
          continue;
        }
        const reason = result ? (result.reason ?? 'rejected') : 'no_result';
        const failed = await markFailed(tx, event.client_event_id, reason);
        report.rejected += 1;
        if (failed.dead) report.deadLettered += 1;
      }
      await markDelivered(tx, delivered, clock.now());
    });
    report.delivered += delivered.length;
  }
}
