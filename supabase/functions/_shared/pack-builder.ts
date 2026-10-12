// Pure pack-building logic of the `publish-pack` edge function (ADR 0004). No I/O, no Node built-ins and no
// Deno globals: it only needs WebCrypto and TextEncoder, so it runs in Deno (edge function) and in Node
// (Vitest, see pack-builder.test.ts). The content-schema helpers come from the vendored bundle (schema.ts).
//
// The output MUST stay byte-identical to `buildPackFiles` of packages/learner-core/src/fakes/pack-builder.ts,
// which defines the contract the device checks (pack-builder.test.ts proves it for the golden unit):
//   * `learner.json`  = JSON.stringify(splitUnitForPacks(unit).learner)   (NO teacher_manual)
//   * `grownup.json`  = JSON.stringify(splitUnitForPacks(unit).grownup)   (the manual; lessons only)
//   * `content_hash`  = sha256 hex of JSON.stringify(unit), `unit` being the PARSED unit (parseUnit)
//   * media/audio     = `media/<asset_id>.<ext>` / `audio/<asset_id>.<ext>` (manifest path) stored under
//                       `blobs/<sha256>`; JSON is uncompressed UTF-8.
// Note: the bytes depend on the key order of the content (maps such as `questions` keep it). Content read
// from Postgres jsonb has jsonb's key order, so a pack built from the database can differ in byte order from
// one built from a fixture; for one snapshot the output is always the same.

import {
  GROWNUP_CONTENT_PATH,
  LEARNER_CONTENT_PATH,
  contentTypeFor,
  manifestStoragePath,
  storagePathFor,
} from './pack-layout.ts';
import type { PackFileEntry, PackManifestShape } from './pack-layout.ts';
import { PackManifest, parseUnit, splitUnitForPacks, verifyManifestIntegrity } from './schema.ts';

// layout and schema helpers are part of this module's surface (the tests and publish-pack import them here)
export {
  GROWNUP_CONTENT_PATH,
  LEARNER_CONTENT_PATH,
  contentTypeFor,
  manifestStoragePath,
  storagePathFor,
  PackManifest,
  parseUnit,
  verifyManifestIntegrity,
};
export type { PackFileEntry, PackManifestShape };

/** A media or audio file to put into a pack (unit illustrations are placeholders for now: none). */
export interface PackMediaInput {
  assetId: string;
  bytes: Uint8Array;
  /** File extension without the dot, for example `webp` or `mp3`. */
  ext: string;
  /** Default `media`. */
  kind?: 'media' | 'audio';
}

export interface BuildPackInput {
  unitId: string;
  versionNo: number;
  minAppVersion: string;
  /** The published snapshot's `content` (unknown shape until parsed by the content schema). */
  content: unknown;
  media?: readonly PackMediaInput[];
}

/** One object to write to the `packs` bucket. */
export interface PackObject {
  storagePath: string;
  bytes: Uint8Array;
  contentType: string;
}

export interface BuiltPack {
  manifest: PackManifestShape;
  /** Storage path of the manifest (what `published_units.pack_manifest_path` records). */
  manifestPath: string;
  /** sha256 of the parsed unit; equals `manifest.content_hash` (what `published_units.content_hash` records). */
  contentHash: string;
  /** Bytes of every manifest file, keyed by the manifest `path` (the same shape as buildPackFiles). */
  files: Map<string, Uint8Array>;
  /** Everything to upload, deduplicated by storage path, the manifest LAST. */
  objects: PackObject[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Builds the manifest and the objects of a pack from a published snapshot. Throws when the content does
 * not parse (a snapshot is expected to be valid; the pack is never built from garbage) or when the result
 * fails the manifest checks.
 */
export async function buildPack(input: BuildPackInput): Promise<BuiltPack> {
  if (!UUID.test(input.unitId)) throw new Error('unitId must be a UUID');
  if (!Number.isInteger(input.versionNo) || input.versionNo < 1) {
    throw new Error('versionNo must be a positive integer');
  }

  const unit = parseUnit(input.content);
  const { learner, grownup } = splitUnitForPacks(unit);
  if (Object.hasOwn(learner, 'teacher_manual')) {
    throw new Error('the learner pack must not contain teacher_manual');
  }

  const files = new Map<string, Uint8Array>();
  const entries: PackFileEntry[] = [];
  const add = async (
    path: string,
    bytes: Uint8Array,
    kind: PackFileEntry['kind'],
    pack: PackFileEntry['pack'],
    assetId?: string,
  ): Promise<void> => {
    files.set(path, bytes);
    entries.push({
      path,
      sha256: await sha256Hex(bytes),
      bytes: bytes.length,
      kind,
      pack,
      ...(assetId !== undefined ? { asset_id: assetId } : {}),
    });
  };

  await add(LEARNER_CONTENT_PATH, encoder.encode(JSON.stringify(learner)), 'content', 'learner');
  if (grownup) {
    await add(GROWNUP_CONTENT_PATH, encoder.encode(JSON.stringify(grownup)), 'content', 'grownup');
  }
  for (const item of input.media ?? []) {
    const kind = item.kind ?? 'media';
    const folder = kind === 'audio' ? 'audio' : 'media';
    await add(`${folder}/${item.assetId}.${item.ext}`, item.bytes, kind, 'learner', item.assetId);
  }

  const contentHash = await sha256Hex(encoder.encode(JSON.stringify(unit)));
  const manifest: PackManifestShape = {
    pack_version: 1,
    unit_id: input.unitId,
    version_no: input.versionNo,
    schema_version: unit.schema_version,
    min_app_version: input.minAppVersion,
    content_hash: contentHash,
    files: entries,
    learner_content_path: LEARNER_CONTENT_PATH,
    grownup_content_path: grownup ? GROWNUP_CONTENT_PATH : null,
  };

  // the same checks the device runs before it trusts a manifest
  const parsed = PackManifest.parse(manifest);
  const problems = verifyManifestIntegrity(parsed);
  if (problems.length > 0) throw new Error(`invalid pack manifest: ${problems.join('; ')}`);

  const objects = new Map<string, PackObject>();
  for (const entry of entries) {
    const storagePath = storagePathFor(input.unitId, input.versionNo, entry);
    if (!objects.has(storagePath)) {
      objects.set(storagePath, {
        storagePath,
        bytes: files.get(entry.path) ?? new Uint8Array(),
        contentType: contentTypeFor(entry.path),
      });
    }
  }
  const manifestPath = manifestStoragePath(input.unitId, input.versionNo);
  objects.set(manifestPath, {
    storagePath: manifestPath,
    bytes: encoder.encode(JSON.stringify(manifest)),
    contentType: 'application/json',
  });

  return { manifest, manifestPath, contentHash, files, objects: [...objects.values()] };
}
