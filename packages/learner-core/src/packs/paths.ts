/**
 * Where pack files live inside the app-private file store (paths are relative to the store's root; the
 * `FileStore` and the `Downloader` must resolve them against the same root).
 *
 *   packs/<unit_id>/<version_no>/manifest.json   the immutable manifest (written by the download manager)
 *   packs/<unit_id>/<version_no>/<path>          JSON content files, exactly as the manifest names them
 *   blobs/<sha256>                               media and audio, content-addressed and shared
 */

export function versionDir(unitId: string, versionNo: number): string {
  return `packs/${unitId}/${versionNo}`;
}

export function manifestPath(unitId: string, versionNo: number): string {
  return `${versionDir(unitId, versionNo)}/manifest.json`;
}

export function blobPath(sha256: string): string {
  return `blobs/${sha256}`;
}

/** The on-device path of a manifest file. */
export function localPathFor(
  unitId: string,
  versionNo: number,
  file: { path: string; sha256: string; kind: 'content' | 'media' | 'audio' },
): string {
  return file.kind === 'content'
    ? `${versionDir(unitId, versionNo)}/${file.path}`
    : blobPath(file.sha256);
}
