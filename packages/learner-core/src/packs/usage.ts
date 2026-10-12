import { getActivePack, listAllPackFiles } from '../db/packs';
import type { Ports } from '../ports';

export interface VersionUsage {
  unitId: string;
  versionNo: number;
  /** `active` plays now; `superseded` waits for `releaseSuperseded`; `partial` is an unfinished download. */
  role: 'active' | 'superseded' | 'partial';
  /** Bytes this version references (a blob shared with another version is counted in each). */
  bytes: number;
}

export interface StorageUsage {
  /** Bytes on disk for all packs: shared blobs counted once, plus unfinished downloads so far. */
  totalBytes: number;
  versions: VersionUsage[];
  /** Free space on the device volume. */
  freeBytes: number;
}

/** The storage meter: what lessons occupy, from the bookkeeping tables (no disk scan). */
export async function storageUsage(ports: Pick<Ports, 'db' | 'files'>): Promise<StorageUsage> {
  const rows = await listAllPackFiles(ports.db);
  const blobs = new Map<string, number>();
  let contentBytes = 0;
  let partialBytes = 0;
  const perVersion = new Map<string, VersionUsage>();

  for (const row of rows) {
    const held = row.state === 'verified' ? row.bytes : row.downloaded_bytes;
    if (row.kind === 'content') contentBytes += held;
    else if (row.state === 'verified') blobs.set(row.sha256, row.bytes);
    else partialBytes += held;

    const key = `${row.unit_id}:${row.version_no}`;
    let entry = perVersion.get(key);
    if (!entry) {
      const active = await getActivePack(ports.db, row.unit_id);
      const role =
        active?.version_no === row.version_no
          ? 'active'
          : active?.superseded_version_no === row.version_no
            ? 'superseded'
            : 'partial';
      entry = { unitId: row.unit_id, versionNo: row.version_no, role, bytes: 0 };
      perVersion.set(key, entry);
    }
    entry.bytes += held;
  }

  const blobBytes = [...blobs.values()].reduce((sum, bytes) => sum + bytes, 0);
  return {
    totalBytes: contentBytes + blobBytes + partialBytes,
    versions: [...perVersion.values()],
    freeBytes: await ports.files.freeDiskBytes(),
  };
}
