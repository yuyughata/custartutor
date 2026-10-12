import { SyncApiError, toSyncApiError } from '../api';
import type { SyncApi } from '../api';
import { META, getLastSyncSeq, getMetaNumber, setMetaNumber } from '../db/meta';
import { purgeUnknownChildren } from '../db/outbox';
import { getHousehold, wipeServerData } from '../db/reference';
import type { TrustedClock } from '../clock';
import type { SqlDriver } from '../ports';
import { DEFAULT_PULL_LIMIT, PullResponse } from '../wire';
import { applyPage, pageRowCount } from './apply';
import { emptyPull } from './result';
import type { PullReport } from './result';

export interface PullDeps {
  db: SqlDriver;
  api: SyncApi;
  clock: TrustedClock;
  pullLimit?: number;
}

export type PullOutcome =
  { ok: true; report: PullReport } | { ok: false; error: SyncApiError; report: PullReport };

const MAX_PAGES = 10_000;
const MAX_RESYNCS = 2;

/**
 * PULL: loops `api.pull(last_sync_seq, limit)` until `has_more` is false.
 *
 *  - One transaction per page; the cursor moves in that transaction, so a failure part-way through a page
 *    leaves the data and the cursor exactly as before (the page is simply fetched again).
 *  - Tombstones delete local rows.
 *  - If a page's `epoch` differs from the stored `membership_epoch` (or its household is a different one, as
 *    after switching accounts), access changed: household, child, subject,
 *    unit, published and unit_progress are wiped, the cursor goes back to 0 and the pull restarts, so revoked
 *    data is purged. The outbox and downloaded pack files are kept; after the new picture is complete, local
 *    events and unsent rows of children the account can no longer see are dropped too.
 *  - After each applied page the device is anchored to the page's `server_time` (offline grace window).
 */
export async function pullAll(deps: PullDeps): Promise<PullOutcome> {
  const { db, api, clock } = deps;
  const limit = deps.pullLimit ?? DEFAULT_PULL_LIMIT;
  const report = emptyPull();
  let resyncs = 0;

  for (let guard = 0; guard < MAX_PAGES; guard += 1) {
    const since = await getLastSyncSeq(db);
    let page: PullResponse;
    try {
      const parsed = PullResponse.safeParse(await api.pull(since, limit));
      if (!parsed.success) throw new SyncApiError('bad_response', 'Malformed pull response');
      page = parsed.data;
    } catch (error) {
      return { ok: false, error: toSyncApiError(error), report };
    }

    const storedEpoch = await getMetaNumber(db, META.membershipEpoch);
    // Epochs are per household, so two accounts can share a number: a different household id counts as a change too.
    const storedHousehold = await getHousehold(db);
    const householdChanged =
      storedHousehold !== null && (page.household?.id ?? null) !== storedHousehold.id;
    if (householdChanged || (storedEpoch !== null && storedEpoch !== page.epoch)) {
      if (resyncs >= MAX_RESYNCS) {
        const error = new SyncApiError('server', 'Household epoch kept changing during sync');
        return { ok: false, error, report };
      }
      resyncs += 1;
      report.fullResync = true;
      await db.transaction(async (tx) => {
        await wipeServerData(tx);
        await setMetaNumber(tx, META.membershipEpoch, page.epoch);
        await setMetaNumber(tx, META.lastSyncSeq, 0);
      });
      continue;
    }

    if (page.has_more && page.next_seq <= since) {
      const error = new SyncApiError(
        'bad_response',
        'Server reported more rows but did not advance',
      );
      return { ok: false, error, report };
    }

    // A database error here is not a network problem: let it propagate (the engine reports it as `internal`).
    await db.transaction(async (tx) => {
      await applyPage(tx, page);
      if (storedEpoch === null) await setMetaNumber(tx, META.membershipEpoch, page.epoch);
    });
    report.pages += 1;
    report.rows += pageRowCount(page);
    await clock.anchor(page.server_time);

    if (!page.has_more) {
      if (report.fullResync) await db.transaction((tx) => purgeUnknownChildren(tx));
      return { ok: true, report };
    }
  }
  return { ok: false, error: new SyncApiError('bad_response', 'Too many pull pages'), report };
}
