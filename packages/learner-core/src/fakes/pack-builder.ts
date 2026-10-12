import { splitUnitForPacks } from '@custar/content-schema';
import type { PackFile, PackManifest, UnitContent } from '@custar/content-schema';
import type { Hasher } from '../ports';
import { encodeUtf8 } from '../utf8';
import { WebCryptoHasher } from './web-crypto-hasher';

/** A media or audio file to put into a pack. */
export interface PackMedia {
  /** The content asset id (`illustration.asset_id`, `audio_refs[]`). */
  assetId: string;
  bytes: Uint8Array;
  /** File extension without the dot, for example `webp` or `mp3`. */
  ext: string;
  /** Default `media`. */
  kind?: 'media' | 'audio';
}

export interface BuildPackOptions {
  /** The unit's database id (UUID). */
  unitId: string;
  /** Default 1. */
  versionNo?: number;
  /** Default `1.0.0`. */
  minAppVersion?: string;
  media?: readonly PackMedia[];
  hasher?: Pick<Hasher, 'sha256Hex'>;
}

export interface BuiltPack {
  manifest: PackManifest;
  /** The bytes of every manifest file, keyed by the manifest `path`. */
  files: Map<string, Uint8Array>;
}

/** Paths used inside every pack. */
export const LEARNER_CONTENT_PATH = 'learner.json';
export const GROWNUP_CONTENT_PATH = 'grownup.json';

/**
 * Builds the manifest and file bytes of a pack for a parsed unit, the way the real pack builder does:
 *
 *  1. `splitUnitForPacks(unit)` gives the learner content (everything but the teacher's manual) and the grown-up
 *     content (the manual). Both are stored as UNCOMPRESSED UTF-8 JSON (`learner.json`, `grownup.json`).
 *  2. Media and audio become `media/<asset_id>.<ext>` / `audio/<asset_id>.<ext>` entries. On the device they are
 *     stored content-addressed as `blobs/<sha256>`.
 *  3. `content_hash` is the SHA-256 of `JSON.stringify(unit)` of the whole parsed unit (before the split), so it
 *     changes whenever anything in the unit changes. The server stores the same value in `published_units`.
 *
 * Every file carries its SHA-256 and byte length; `files` holds the exact bytes those describe.
 */
export async function buildPackFiles(
  unit: UnitContent,
  options: BuildPackOptions,
): Promise<BuiltPack> {
  const hasher = options.hasher ?? new WebCryptoHasher();
  const { learner, grownup } = splitUnitForPacks(unit);
  const files = new Map<string, Uint8Array>();
  const entries: PackFile[] = [];

  const add = async (
    path: string,
    bytes: Uint8Array,
    kind: PackFile['kind'],
    pack: PackFile['pack'],
    assetId?: string,
  ): Promise<void> => {
    files.set(path, bytes);
    entries.push({
      path,
      sha256: await hasher.sha256Hex(bytes),
      bytes: bytes.length,
      kind,
      pack,
      ...(assetId !== undefined ? { asset_id: assetId } : {}),
    });
  };

  await add(LEARNER_CONTENT_PATH, encodeUtf8(JSON.stringify(learner)), 'content', 'learner');
  if (grownup) {
    await add(GROWNUP_CONTENT_PATH, encodeUtf8(JSON.stringify(grownup)), 'content', 'grownup');
  }
  for (const item of options.media ?? []) {
    const kind = item.kind ?? 'media';
    const folder = kind === 'audio' ? 'audio' : 'media';
    await add(`${folder}/${item.assetId}.${item.ext}`, item.bytes, kind, 'learner', item.assetId);
  }

  const manifest: PackManifest = {
    pack_version: 1,
    unit_id: options.unitId,
    version_no: options.versionNo ?? 1,
    schema_version: unit.schema_version,
    min_app_version: options.minAppVersion ?? '1.0.0',
    content_hash: await hasher.sha256Hex(encodeUtf8(JSON.stringify(unit))),
    files: entries,
    learner_content_path: LEARNER_CONTENT_PATH,
    grownup_content_path: grownup ? GROWNUP_CONTENT_PATH : null,
  };
  return { manifest, files };
}
