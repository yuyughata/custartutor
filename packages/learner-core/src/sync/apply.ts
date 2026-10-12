import { setMetaNumber, META } from '../db/meta';
import { deleteUnitProgress, upsertUnitProgress } from '../db/progress';
import {
  deleteChildCascade,
  deletePublished,
  deleteSubject,
  deleteUnit,
  setHousehold,
  upsertChild,
  upsertPublished,
  upsertSubject,
  upsertUnit,
} from '../db/reference';
import type { SqlDriver } from '../ports';
import type { PullResponse } from '../wire';

/** Number of syncable rows in a page. */
export function pageRowCount(page: PullResponse): number {
  return (
    page.children.length +
    page.subjects.length +
    page.units.length +
    page.published.length +
    page.unit_progress.length
  );
}

/**
 * Applies one pull page inside the caller's transaction: upserts live rows, deletes tombstoned ones (a deleted
 * child takes their progress, local events and unsent outbox rows with them) and finally moves the cursor.
 * The cursor is written LAST and in the same transaction, so it can only advance together with the data.
 */
export async function applyPage(tx: SqlDriver, page: PullResponse): Promise<void> {
  await setHousehold(tx, page.household);

  const deletedChildren = new Set<string>();
  for (const row of page.children) {
    if (row.deleted_at !== null) {
      deletedChildren.add(row.id);
      await deleteChildCascade(tx, row.id);
    } else {
      await upsertChild(tx, row);
    }
  }
  for (const row of page.subjects) {
    if (row.deleted_at !== null) await deleteSubject(tx, row.id);
    else await upsertSubject(tx, row);
  }
  for (const row of page.units) {
    if (row.deleted_at !== null) await deleteUnit(tx, row.id);
    else await upsertUnit(tx, row);
  }
  for (const row of page.published) {
    if (row.deleted_at !== null) await deletePublished(tx, row.unit_id, row.version_no);
    else await upsertPublished(tx, row);
  }
  for (const row of page.unit_progress) {
    if (row.deleted_at !== null) await deleteUnitProgress(tx, row.child_id, row.unit_id);
    else if (!deletedChildren.has(row.child_id)) await upsertUnitProgress(tx, row);
  }

  await setMetaNumber(tx, META.lastSyncSeq, page.next_seq);
}
