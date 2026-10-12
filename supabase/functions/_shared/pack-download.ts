// Pure logic of the `get-pack-download` edge function: validating the request, trusting nothing the storage
// layer returns until it has been checked against what the DATABASE authorised, and shaping the response
// exactly as `PackDownload` in packages/learner-core/src/wire.ts.

import { HttpError } from './http.ts';
import { manifestStoragePath, storagePathFor } from './pack-layout.ts';
import type { PackManifestShape } from './pack-layout.ts';
import { PackManifest, verifyManifestIntegrity } from './schema.ts';

/** How long signed URLs live: two hours (the wire contract asks for at least one). */
export const URL_TTL_SECONDS = 2 * 60 * 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

export interface DownloadRequest {
  unitId: string;
  versionNo: number;
}

/** `{ p_unit_id, p_version_no }` (the RPC argument names of wire.ts). */
export function parseDownloadRequest(body: Record<string, unknown>): DownloadRequest {
  const unitId = body.p_unit_id;
  const versionNo = body.p_version_no;
  if (typeof unitId !== 'string' || !UUID.test(unitId)) {
    throw new HttpError(400, 'invalid_unit_id');
  }
  if (typeof versionNo !== 'number' || !Number.isInteger(versionNo) || versionNo < 1) {
    throw new HttpError(400, 'invalid_version_no');
  }
  return { unitId: unitId.toLowerCase(), versionNo };
}

export interface AuthorizedPack {
  manifest_path: string;
  content_hash: string;
}

/**
 * The answer of `authorize_pack_download`. The path must be the canonical manifest path of exactly the
 * unit and version that was asked for: the function never signs anything outside that folder.
 */
export function parseAuthorizedPack(
  data: unknown,
  unitId: string,
  versionNo: number,
): AuthorizedPack {
  const row = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
  const path = row.manifest_path;
  const hash = row.content_hash;
  if (
    typeof path !== 'string' ||
    path !== manifestStoragePath(unitId, versionNo) ||
    typeof hash !== 'string' ||
    !SHA256.test(hash)
  ) {
    console.error('authorize_pack_download returned an unexpected row', data);
    throw new HttpError(500, 'internal_error');
  }
  return { manifest_path: path, content_hash: hash };
}

/**
 * Parses the manifest read from storage and checks that it is the one the database authorised: same unit,
 * same version, same content hash, a sound structure. A manifest that disagrees is a corrupt pack (500),
 * never something to hand to a device.
 */
export function parseStoredManifest(
  text: string,
  authorised: AuthorizedPack,
  unitId: string,
  versionNo: number,
): PackManifestShape {
  let manifest: PackManifestShape;
  try {
    manifest = PackManifest.parse(JSON.parse(text));
  } catch (error) {
    console.error('stored manifest does not parse', error);
    throw new HttpError(500, 'pack_corrupt');
  }
  const problems = verifyManifestIntegrity(manifest);
  if (
    manifest.unit_id.toLowerCase() !== unitId ||
    manifest.version_no !== versionNo ||
    manifest.content_hash !== authorised.content_hash ||
    problems.length > 0
  ) {
    console.error('stored manifest disagrees with the database', { unitId, versionNo, problems });
    throw new HttpError(500, 'pack_corrupt');
  }
  return manifest;
}

/** The distinct storage objects to sign: every file of BOTH packs (the client chooses what to fetch). */
export function signedPathsOf(manifest: PackManifestShape): string[] {
  const paths = new Set<string>();
  for (const file of manifest.files) {
    paths.add(storagePathFor(manifest.unit_id.toLowerCase(), manifest.version_no, file));
  }
  return [...paths];
}

/** One element of the result of storage `createSignedUrls`. */
export interface SignedUrl {
  path: string | null;
  signedUrl: string;
  error: string | null;
}

export interface PackDownloadBody {
  manifest: PackManifestShape;
  urls: Record<string, string>;
  expires_at: string;
}

/**
 * The `PackDownload` of wire.ts: the manifest, one signed URL per `manifest.files[].path` (keyed by the
 * logical path; two paths with the same bytes share one object), and when the URLs stop working.
 */
export function buildDownload(
  manifest: PackManifestShape,
  signed: readonly SignedUrl[],
  ttlSeconds: number,
  nowMs: number,
): PackDownloadBody {
  const byPath = new Map<string, string>();
  for (const item of signed) {
    if (item.error || !item.path || !item.signedUrl) {
      console.error('could not sign a pack file', item);
      throw new HttpError(502, 'pack_unavailable');
    }
    byPath.set(item.path, item.signedUrl);
  }
  const urls: Record<string, string> = {};
  for (const file of manifest.files) {
    const storagePath = storagePathFor(manifest.unit_id.toLowerCase(), manifest.version_no, file);
    const url = byPath.get(storagePath);
    if (!url) {
      console.error('no signed url for', storagePath);
      throw new HttpError(502, 'pack_unavailable');
    }
    urls[file.path] = url;
  }
  return { manifest, urls, expires_at: new Date(nowMs + ttlSeconds * 1000).toISOString() };
}
