import {
  clearSuperseded,
  countBlobReferences,
  deleteActivePack,
  deletePackVersionRows,
  getActivePack,
  listUnitPackFiles,
} from '../db/packs';
import type { PackFileRow } from '../db/packs';
import type { Ports } from '../ports';
import { blobPath, localPathFor, manifestPath } from './paths';

type FilePorts = Pick<Ports, 'db' | 'files'>;

export interface ReleaseReport {
  /** Versions whose bookkeeping was removed. */
  versions: number[];
  filesRemoved: number;
  bytesFreed: number;
}

async function safeRemove(ports: FilePorts, path: string): Promise<boolean> {
  try {
    const size = await ports.files.size(path);
    await ports.files.remove(path);
    return size !== null;
  } catch {
    return false; // a file that is already gone (or locked) must not abort cleanup
  }
}

/**
 * Forgets `versions` of a unit: deletes their `pack_file` rows (in one transaction, together with whatever
 * extra bookkeeping `alsoInTransaction` does), then deletes the files. A content-addressed blob is deleted
 * ONLY when no remaining row (any unit, any version) still references it, so a shared picture used by the
 * active version survives. Files go last: if the app dies in between, the rows are already gone and the
 * leftovers are harmless orphans.
 */
async function dropVersions(
  ports: FilePorts,
  unitId: string,
  versions: readonly number[],
  alsoInTransaction?: (tx: Ports['db']) => Promise<void>,
): Promise<ReleaseReport> {
  const doomed = new Map<string, number>(); // path -> bytes

  await ports.db.transaction(async (tx) => {
    const rows: PackFileRow[] = [];
    for (const versionNo of versions) {
      rows.push(...(await listUnitPackFiles(tx, unitId)).filter((r) => r.version_no === versionNo));
      await deletePackVersionRows(tx, unitId, versionNo);
    }
    await alsoInTransaction?.(tx);

    for (const versionNo of versions) doomed.set(manifestPath(unitId, versionNo), 0);
    const seenBlobs = new Set<string>();
    for (const row of rows) {
      if (row.kind === 'content') {
        doomed.set(localPathFor(unitId, row.version_no, row), row.bytes);
        continue;
      }
      if (seenBlobs.has(row.sha256)) continue;
      seenBlobs.add(row.sha256);
      if ((await countBlobReferences(tx, row.sha256)) === 0)
        doomed.set(blobPath(row.sha256), row.bytes);
    }
  });

  let filesRemoved = 0;
  let bytesFreed = 0;
  for (const [path, bytes] of doomed) {
    if (await safeRemove(ports, path)) {
      filesRemoved += 1;
      bytesFreed += bytes;
    }
    await safeRemove(ports, `${path}.part`);
  }
  return { versions: [...versions], filesRemoved, bytesFreed };
}

/**
 * Deletes the version that was swapped out by the last activation. Call it when the child's session ends (the
 * old pack must stay readable while a session still uses it). Never deletes a blob the active version, or any
 * other unit, still references.
 */
export async function releaseSuperseded(ports: FilePorts, unitId: string): Promise<ReleaseReport> {
  const active = await getActivePack(ports.db, unitId);
  const old = active?.superseded_version_no ?? null;
  if (old === null) return { versions: [], filesRemoved: 0, bytesFreed: 0 };
  return dropVersions(ports, unitId, [old], (tx) => clearSuperseded(tx, unitId));
}

/** Deletes every downloaded version of a unit (active, superseded and half-finished) and its bookkeeping. */
export async function removeUnit(ports: FilePorts, unitId: string): Promise<ReleaseReport> {
  const versions = [
    ...new Set((await listUnitPackFiles(ports.db, unitId)).map((r) => r.version_no)),
  ];
  const active = await getActivePack(ports.db, unitId);
  for (const v of [active?.version_no, active?.superseded_version_no]) {
    if (v !== null && v !== undefined && !versions.includes(v)) versions.push(v);
  }
  return dropVersions(ports, unitId, versions, (tx) => deleteActivePack(tx, unitId));
}

/**
 * Drops versions that are neither active, superseded nor in `keep`: abandoned half-downloads of versions
 * the server has since replaced.
 */
export async function discardAbandoned(
  ports: FilePorts,
  unitId: string,
  keep: readonly number[],
): Promise<ReleaseReport> {
  const active = await getActivePack(ports.db, unitId);
  const protectedVersions = new Set<number>(keep);
  if (active) {
    protectedVersions.add(active.version_no);
    if (active.superseded_version_no !== null) protectedVersions.add(active.superseded_version_no);
  }
  const versions = [
    ...new Set((await listUnitPackFiles(ports.db, unitId)).map((r) => r.version_no)),
  ].filter((v) => !protectedVersions.has(v));
  if (versions.length === 0) return { versions: [], filesRemoved: 0, bytesFreed: 0 };
  return dropVersions(ports, unitId, versions);
}
