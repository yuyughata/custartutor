import type { SqlDriver } from '../ports';

export type PackAvailability = 'not_downloaded' | 'up_to_date' | 'update_available';

export interface PackStatus {
  unitId: string;
  /** The newest version the server currently offers. */
  latestVersionNo: number;
  /** The version that plays now, or null if nothing is downloaded. */
  activeVersionNo: number | null;
  availability: PackAvailability;
}

/**
 * Compares what the server offers (`published`, from the last sync) with what is downloaded (`pack_active`).
 * The UI uses it for the "download" and "update available" badges and for background updates. A unit
 * the server no longer offers does not appear (an already downloaded pack stays playable).
 */
export async function packStatuses(db: SqlDriver): Promise<PackStatus[]> {
  const rows = await db.all<{ unit_id: string; latest: number; active: number | null }>(
    `SELECT p.unit_id AS unit_id, MAX(p.version_no) AS latest, a.version_no AS active
     FROM published p LEFT JOIN pack_active a ON a.unit_id = p.unit_id
     GROUP BY p.unit_id ORDER BY p.unit_id`,
  );
  return rows.map((row) => ({
    unitId: row.unit_id,
    latestVersionNo: row.latest,
    activeVersionNo: row.active,
    availability:
      row.active === null
        ? 'not_downloaded'
        : row.active >= row.latest
          ? 'up_to_date'
          : 'update_available',
  }));
}
