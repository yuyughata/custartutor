// Pure logic of the `publish-pack` edge function: validating the request and the snapshot that
// `get_pack_source` returned (the database is trusted for WHO may publish, not for the shape of the data).

import { HttpError } from './http.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const APP_VERSION = /^\d+(\.\d+){0,2}$/;

/** `{ published_unit_id }` */
export function parsePublishRequest(body: Record<string, unknown>): string {
  const id = body.published_unit_id;
  if (typeof id !== 'string' || !UUID.test(id))
    throw new HttpError(400, 'invalid_published_unit_id');
  return id.toLowerCase();
}

export interface PackSource {
  publishedUnitId: string;
  unitId: string;
  versionNo: number;
  schemaVersion: number;
  minAppVersion: string;
  isCurrent: boolean;
  deleted: boolean;
  content: unknown;
  /** Set when the pack was already built (then nothing is rebuilt). */
  packManifestPath: string | null;
  contentHash: string | null;
}

export function parsePackSource(data: unknown): PackSource {
  const row = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
  const text = (key: string): string | null => {
    const value = row[key];
    return typeof value === 'string' ? value : null;
  };
  const num = (key: string): number | null => {
    const value = row[key];
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : null;
  };
  const publishedUnitId = text('published_unit_id');
  const unitId = text('unit_id');
  const versionNo = num('version_no');
  const schemaVersion = num('schema_version');
  const minAppVersion = text('min_app_version');
  const path = row.pack_manifest_path;
  const hash = row.content_hash;
  if (
    !publishedUnitId ||
    !UUID.test(publishedUnitId) ||
    !unitId ||
    !UUID.test(unitId) ||
    versionNo === null ||
    schemaVersion === null ||
    !minAppVersion ||
    !APP_VERSION.test(minAppVersion) ||
    typeof row.is_current !== 'boolean' ||
    typeof row.deleted !== 'boolean' ||
    typeof row.content !== 'object' ||
    row.content === null ||
    (path !== null && typeof path !== 'string') ||
    (hash !== null && (typeof hash !== 'string' || !SHA256.test(hash)))
  ) {
    console.error('get_pack_source returned an unexpected row');
    throw new HttpError(500, 'internal_error');
  }
  return {
    publishedUnitId: publishedUnitId.toLowerCase(),
    unitId: unitId.toLowerCase(),
    versionNo,
    schemaVersion,
    minAppVersion,
    isCurrent: row.is_current,
    deleted: row.deleted,
    content: row.content,
    packManifestPath: (path as string | null) ?? null,
    contentHash: (hash as string | null) ?? null,
  };
}
