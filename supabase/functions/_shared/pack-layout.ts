// The shape and the storage layout of a pack (ADR 0004). Pure constants, types and path functions: no I/O,
// no Deno globals, no vendored code. Shared by the publish-pack and get-pack-download edge functions.
//
// Storage layout in the private bucket `packs`:
//   units/<unit_id>/<version_no>/manifest.json | learner.json | grownup.json
//   blobs/<sha256>                              (content-addressed media and audio, shared across packs)

export const PACKS_BUCKET = 'packs';
export const LEARNER_CONTENT_PATH = 'learner.json';
export const GROWNUP_CONTENT_PATH = 'grownup.json';
export const MANIFEST_FILE = 'manifest.json';

export interface PackFileEntry {
  path: string;
  sha256: string;
  bytes: number;
  kind: 'content' | 'media' | 'audio';
  pack: 'learner' | 'grownup';
  asset_id?: string;
}

export interface PackManifestShape {
  pack_version: 1;
  unit_id: string;
  version_no: number;
  schema_version: number;
  min_app_version: string;
  content_hash: string;
  files: PackFileEntry[];
  learner_content_path: string;
  grownup_content_path: string | null;
}

const CONTENT_TYPES: Record<string, string> = {
  json: 'application/json',
  webp: 'image/webp',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  webm: 'audio/webm',
  wav: 'audio/wav',
};

/** Content type by file extension; only what the bucket allows (see the pack_publishing migration). */
export function contentTypeFor(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  const type = CONTENT_TYPES[ext];
  if (!type) throw new Error(`pack file "${path}" has an unsupported type`);
  return type;
}

/** `units/<unit_id>/<version_no>`: the folder of one pack version. */
export function packFolder(unitId: string, versionNo: number): string {
  return `units/${unitId}/${versionNo}`;
}

/** Where the manifest of a version lives. Must equal the CHECK on `published_units.pack_manifest_path`. */
export function manifestStoragePath(unitId: string, versionNo: number): string {
  return `${packFolder(unitId, versionNo)}/${MANIFEST_FILE}`;
}

/**
 * Storage path of a manifest file. Content files live in the version folder under their manifest path;
 * media and audio are content-addressed in `blobs/<sha256>`. Only validated unit ids, version numbers and
 * hex digests reach this function (the manifest is parsed first), so a hostile manifest cannot point elsewhere.
 */
export function storagePathFor(
  unitId: string,
  versionNo: number,
  file: Pick<PackFileEntry, 'path' | 'sha256' | 'kind'>,
): string {
  return file.kind === 'content'
    ? `${packFolder(unitId, versionNo)}/${file.path}`
    : `blobs/${file.sha256}`;
}
