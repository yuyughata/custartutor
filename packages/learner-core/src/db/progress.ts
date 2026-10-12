import type { SqlDriver } from '../ports';
import type { UnitProgressRow, UnitProgressStatus } from '../wire';

/** Server-derived `unit_progress` rows, exactly as the last pull left them. */

export type LocalUnitProgress = {
  child_id: string;
  unit_id: string;
  status: UnitProgressStatus;
  mastery_score: number | null;
  attempts: number;
  last_section: string | null;
  updated_at: string;
  sync_seq: number;
};

export async function upsertUnitProgress(tx: SqlDriver, row: UnitProgressRow): Promise<void> {
  await tx.run(
    `INSERT INTO unit_progress (child_id, unit_id, status, mastery_score, attempts, last_section, updated_at, sync_seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(child_id, unit_id) DO UPDATE SET
       status = excluded.status, mastery_score = excluded.mastery_score, attempts = excluded.attempts,
       last_section = excluded.last_section, updated_at = excluded.updated_at, sync_seq = excluded.sync_seq
     WHERE excluded.sync_seq >= unit_progress.sync_seq`,
    [
      row.child_id,
      row.unit_id,
      row.status,
      row.mastery_score,
      row.attempts,
      row.last_section,
      row.updated_at,
      row.sync_seq,
    ],
  );
}

export async function deleteUnitProgress(
  tx: SqlDriver,
  childId: string,
  unitId: string,
): Promise<void> {
  await tx.run('DELETE FROM unit_progress WHERE child_id = ? AND unit_id = ?', [childId, unitId]);
}

export async function getUnitProgress(
  db: SqlDriver,
  childId: string,
  unitId: string,
): Promise<LocalUnitProgress | null> {
  return (
    (await db.get<LocalUnitProgress>(
      'SELECT * FROM unit_progress WHERE child_id = ? AND unit_id = ?',
      [childId, unitId],
    )) ?? null
  );
}

/** All of a child's server-derived progress, keyed by unit id. */
export async function listChildProgress(
  db: SqlDriver,
  childId: string,
): Promise<Map<string, LocalUnitProgress>> {
  const rows = await db.all<LocalUnitProgress>('SELECT * FROM unit_progress WHERE child_id = ?', [
    childId,
  ]);
  return new Map(rows.map((row) => [row.unit_id, row]));
}
