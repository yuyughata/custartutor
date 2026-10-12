import type { PackFile } from '@custar/content-schema';
import type { SqlDriver } from '../ports';

/** Bookkeeping for downloaded lesson packs: `pack_file` (per file state) and `pack_active` (what plays). */

export type PackFileState = 'pending' | 'partial' | 'verified';

export type PackFileRow = {
  unit_id: string;
  version_no: number;
  path: string;
  sha256: string;
  bytes: number;
  kind: 'content' | 'media' | 'audio';
  pack: 'learner' | 'grownup';
  asset_id: string | null;
  state: PackFileState;
  downloaded_bytes: number;
};

/** Registers the manifest's files as `pending`. Rows that already exist keep their state (resume). */
export async function registerPackFiles(
  tx: SqlDriver,
  unitId: string,
  versionNo: number,
  files: readonly PackFile[],
): Promise<void> {
  for (const file of files) {
    await tx.run(
      `INSERT OR IGNORE INTO pack_file (unit_id, version_no, path, sha256, bytes, kind, pack, asset_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        unitId,
        versionNo,
        file.path,
        file.sha256,
        file.bytes,
        file.kind,
        file.pack,
        file.asset_id ?? null,
      ],
    );
  }
}

export async function setPackFileState(
  db: SqlDriver,
  unitId: string,
  versionNo: number,
  path: string,
  state: PackFileState,
  downloadedBytes: number,
): Promise<void> {
  await db.run(
    'UPDATE pack_file SET state = ?, downloaded_bytes = ? WHERE unit_id = ? AND version_no = ? AND path = ?',
    [state, downloadedBytes, unitId, versionNo, path],
  );
}

export async function listPackFiles(
  db: SqlDriver,
  unitId: string,
  versionNo: number,
): Promise<PackFileRow[]> {
  return db.all<PackFileRow>(
    'SELECT * FROM pack_file WHERE unit_id = ? AND version_no = ? ORDER BY path',
    [unitId, versionNo],
  );
}

export async function listUnitPackFiles(db: SqlDriver, unitId: string): Promise<PackFileRow[]> {
  return db.all<PackFileRow>(
    'SELECT * FROM pack_file WHERE unit_id = ? ORDER BY version_no, path',
    [unitId],
  );
}

export async function listAllPackFiles(db: SqlDriver): Promise<PackFileRow[]> {
  return db.all<PackFileRow>('SELECT * FROM pack_file ORDER BY unit_id, version_no, path');
}

/** Any verified media/audio row with this hash (the blob should already be on disk). */
export async function findVerifiedBlob(db: SqlDriver, sha256: string): Promise<PackFileRow | null> {
  return (
    (await db.get<PackFileRow>(
      "SELECT * FROM pack_file WHERE sha256 = ? AND kind <> 'content' AND state = 'verified' LIMIT 1",
      [sha256],
    )) ?? null
  );
}

/** How many media/audio rows OTHER than the given (unit, version) still reference this blob. */
export async function blobReferencesOutside(
  db: SqlDriver,
  sha256: string,
  unitId: string,
  versionNo: number,
): Promise<number> {
  const row = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM pack_file
     WHERE sha256 = ? AND kind <> 'content' AND NOT (unit_id = ? AND version_no = ?)`,
    [sha256, unitId, versionNo],
  );
  return row?.n ?? 0;
}

export async function deletePackVersionRows(
  tx: SqlDriver,
  unitId: string,
  versionNo: number,
): Promise<void> {
  await tx.run('DELETE FROM pack_file WHERE unit_id = ? AND version_no = ?', [unitId, versionNo]);
}

// ---- pack_active -------------------------------------------------------------------------------

export type PackActiveRow = {
  unit_id: string;
  version_no: number;
  activated_at: number;
  superseded_version_no: number | null;
};

export async function getActivePack(db: SqlDriver, unitId: string): Promise<PackActiveRow | null> {
  return (
    (await db.get<PackActiveRow>('SELECT * FROM pack_active WHERE unit_id = ?', [unitId])) ?? null
  );
}

export async function listActivePacks(db: SqlDriver): Promise<PackActiveRow[]> {
  return db.all<PackActiveRow>('SELECT * FROM pack_active ORDER BY unit_id');
}

/**
 * Switches the unit to `versionNo` in one statement (call it inside a transaction). The previously active
 * version, if different, becomes `superseded_version_no`: its files stay on disk until `releaseSuperseded`.
 * Returns that version. Activating the version that is already active changes nothing. The caller must
 * release an OLDER superseded version first, or it would be forgotten (see `DownloadManager`).
 */
export async function activatePack(
  tx: SqlDriver,
  unitId: string,
  versionNo: number,
  now: number,
): Promise<{ superseded: number | null }> {
  const current = await getActivePack(tx, unitId);
  if (current && current.version_no === versionNo) {
    return { superseded: current.superseded_version_no };
  }
  const superseded = current ? current.version_no : null;
  await tx.run(
    `INSERT INTO pack_active (unit_id, version_no, activated_at, superseded_version_no)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(unit_id) DO UPDATE SET
       version_no = excluded.version_no, activated_at = excluded.activated_at,
       superseded_version_no = excluded.superseded_version_no`,
    [unitId, versionNo, now, superseded],
  );
  return { superseded };
}

export async function clearSuperseded(tx: SqlDriver, unitId: string): Promise<void> {
  await tx.run('UPDATE pack_active SET superseded_version_no = NULL WHERE unit_id = ?', [unitId]);
}

export async function deleteActivePack(tx: SqlDriver, unitId: string): Promise<void> {
  await tx.run('DELETE FROM pack_active WHERE unit_id = ?', [unitId]);
}
