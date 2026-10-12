import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { goldenUnit2, colourChartProject } from '../../../packages/content-schema/src/fixtures';
import { buildPackFiles } from '../../../packages/learner-core/src/fakes/pack-builder';
import {
  GROWNUP_CONTENT_PATH,
  LEARNER_CONTENT_PATH,
  buildPack,
  contentTypeFor,
  manifestStoragePath,
  parseUnit,
  PackManifest,
  sha256Hex,
  storagePathFor,
  verifyManifestIntegrity,
} from './pack-builder';

const UNIT_ID = '11111111-1111-4111-8111-111111111111';
/** What Postgres jsonb does to object keys: shorter keys first, then bytewise. */
function jsonbOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonbOrder);
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
    return Object.fromEntries(
      keys.map((key) => [key, jsonbOrder((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}
const decode = (bytes: Uint8Array | undefined) =>
  new TextDecoder().decode(bytes ?? new Uint8Array());
const encode = (text: string) => new TextEncoder().encode(text);

describe('buildPack matches the learner-core reference builder (buildPackFiles)', () => {
  it('is byte-identical for goldenUnit2: manifest, hashes, paths and every file', async () => {
    const options = { unitId: UNIT_ID, versionNo: 3, minAppVersion: '1.2.0' };
    const reference = await buildPackFiles(parseUnit(goldenUnit2), options);
    const built = await buildPack({ ...options, content: goldenUnit2 });

    expect(built.manifest).toEqual(reference.manifest);
    expect(JSON.stringify(built.manifest)).toBe(JSON.stringify(reference.manifest));
    expect(built.contentHash).toBe(reference.manifest.content_hash);
    expect([...built.files.keys()]).toEqual([...reference.files.keys()]);
    for (const [path, bytes] of reference.files) {
      expect(Buffer.from(built.files.get(path) ?? []).equals(Buffer.from(bytes)), path).toBe(true);
    }
  });

  it('is byte-identical with media and audio too, and still validates', async () => {
    const media = [
      { assetId: 'zari', bytes: encode('png-bytes'), ext: 'png' },
      { assetId: 'intro', bytes: encode('mp3-bytes'), ext: 'mp3', kind: 'audio' as const },
    ];
    const options = { unitId: UNIT_ID, versionNo: 1, minAppVersion: '1.0.0', media };
    const reference = await buildPackFiles(parseUnit(goldenUnit2), options);
    const built = await buildPack({ ...options, content: goldenUnit2 });
    expect(built.manifest).toEqual(reference.manifest);
    expect(verifyManifestIntegrity(built.manifest)).toEqual([]);
    expect(built.manifest.files.find((f) => f.path === 'audio/intro.mp3')).toMatchObject({
      kind: 'audio',
      pack: 'learner',
      asset_id: 'intro',
    });
  });

  it('is byte-identical for a project unit, which has no grown-up pack', async () => {
    const options = { unitId: UNIT_ID, versionNo: 1, minAppVersion: '1.0.0' };
    const reference = await buildPackFiles(parseUnit(colourChartProject), options);
    const built = await buildPack({ ...options, content: colourChartProject });
    expect(built.manifest).toEqual(reference.manifest);
    expect(built.manifest.grownup_content_path).toBeNull();
    expect(built.files.has(GROWNUP_CONTENT_PATH)).toBe(false);
  });

  it('gives the same pack for content that went through JSON (as read from jsonb)', async () => {
    const options = { unitId: UNIT_ID, versionNo: 1, minAppVersion: '1.0.0' };
    const direct = await buildPack({ ...options, content: goldenUnit2 });
    const viaJson = await buildPack({
      ...options,
      content: JSON.parse(JSON.stringify(goldenUnit2)),
    });
    expect(viaJson.manifest).toEqual(direct.manifest);
  });
});

describe('content as stored in jsonb', () => {
  it('builds a valid, stable pack (key order of maps follows jsonb, so bytes may differ from the fixture)', async () => {
    const input = {
      unitId: UNIT_ID,
      versionNo: 1,
      minAppVersion: '1.0.0',
      content: jsonbOrder(goldenUnit2),
    };
    const a = await buildPack(input);
    const b = await buildPack(input);
    expect(a.manifest).toEqual(b.manifest);
    expect(verifyManifestIntegrity(a.manifest)).toEqual([]);
    // the grown-up pack and the unit meaning are the same as for the fixture
    const reference = await buildPack({ ...input, content: goldenUnit2 });
    expect(a.manifest.files.find((f) => f.pack === 'grownup')).toEqual(
      reference.manifest.files.find((f) => f.pack === 'grownup'),
    );
    expect(JSON.parse(decode(a.files.get(LEARNER_CONTENT_PATH)))).toEqual(
      JSON.parse(decode(reference.files.get(LEARNER_CONTENT_PATH))),
    );
  });
});

describe('the two packs', () => {
  it('keeps the teacher manual OUT of the learner pack and in the grown-up pack', async () => {
    const built = await buildPack({
      unitId: UNIT_ID,
      versionNo: 1,
      minAppVersion: '1.0.0',
      content: goldenUnit2,
    });
    const learner = decode(built.files.get(LEARNER_CONTENT_PATH));
    const grownup = decode(built.files.get(GROWNUP_CONTENT_PATH));
    expect(learner.startsWith('{')).toBe(true);
    expect(learner).not.toContain('teacher_manual');
    expect(Object.hasOwn(JSON.parse(learner), 'teacher_manual')).toBe(false);
    expect(JSON.parse(grownup)).toMatchObject({ kind: 'lesson' });
    expect(Object.hasOwn(JSON.parse(grownup), 'teacher_manual')).toBe(true);
    // answers and tutor scripts stay in the learner pack on purpose (offline grading, Tutor Lite)
    expect(learner).toContain('"questions"');
  });

  it('stores JSON uncompressed and describes every file by its real bytes', async () => {
    const built = await buildPack({
      unitId: UNIT_ID,
      versionNo: 2,
      minAppVersion: '1.0.0',
      content: goldenUnit2,
    });
    for (const file of built.manifest.files) {
      const bytes = built.files.get(file.path);
      expect(bytes?.length, file.path).toBe(file.bytes);
      expect(
        createHash('sha256')
          .update(bytes ?? new Uint8Array())
          .digest('hex'),
        file.path,
      ).toBe(file.sha256);
    }
    expect(await sha256Hex(encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('is deterministic: building twice gives identical bytes and hashes', async () => {
    const input = {
      unitId: UNIT_ID,
      versionNo: 1,
      minAppVersion: '1.0.0',
      content: goldenUnit2,
    };
    const a = await buildPack(input);
    const b = await buildPack(input);
    expect(a.manifest).toEqual(b.manifest);
    expect(a.objects.map((o) => [o.storagePath, Buffer.from(o.bytes).toString('hex')])).toEqual(
      b.objects.map((o) => [o.storagePath, Buffer.from(o.bytes).toString('hex')]),
    );
  });

  it('changes content_hash when the unit changes', async () => {
    const changed = structuredClone(goldenUnit2);
    changed.header.title = 'Changed';
    const input = { unitId: UNIT_ID, versionNo: 1, minAppVersion: '1.0.0' };
    const a = await buildPack({ ...input, content: goldenUnit2 });
    const b = await buildPack({ ...input, content: changed });
    expect(a.contentHash).not.toBe(b.contentHash);
  });
});

describe('storage layout', () => {
  it('writes the manifest LAST, at the canonical path, with the right content types', async () => {
    const built = await buildPack({
      unitId: UNIT_ID,
      versionNo: 5,
      minAppVersion: '1.0.0',
      content: goldenUnit2,
      media: [{ assetId: 'zari', bytes: encode('png'), ext: 'png' }],
    });
    const paths = built.objects.map((o) => o.storagePath);
    expect(paths.at(-1)).toBe(`units/${UNIT_ID}/5/manifest.json`);
    expect(built.manifestPath).toBe(manifestStoragePath(UNIT_ID, 5));
    expect(paths).toContain(`units/${UNIT_ID}/5/learner.json`);
    expect(paths).toContain(`units/${UNIT_ID}/5/grownup.json`);
    const media = built.manifest.files.find((f) => f.kind === 'media');
    expect(paths).toContain(`blobs/${media?.sha256}`);
    expect(new Set(paths).size).toBe(paths.length);
    const types = Object.fromEntries(built.objects.map((o) => [o.storagePath, o.contentType]));
    expect(types[`units/${UNIT_ID}/5/manifest.json`]).toBe('application/json');
    expect(types[`blobs/${media?.sha256}`]).toBe('image/png');
  });

  it('stores one object per distinct blob even when two paths share the same bytes', async () => {
    const built = await buildPack({
      unitId: UNIT_ID,
      versionNo: 1,
      minAppVersion: '1.0.0',
      content: goldenUnit2,
      media: [
        { assetId: 'a', bytes: encode('same'), ext: 'webp' },
        { assetId: 'b', bytes: encode('same'), ext: 'webp' },
      ],
    });
    const blobs = built.objects.filter((o) => o.storagePath.startsWith('blobs/'));
    expect(blobs).toHaveLength(1);
    expect(built.manifest.files.filter((f) => f.kind === 'media')).toHaveLength(2);
  });

  it('maps content files into the version folder and media into blobs/<sha256>', () => {
    const sha = 'a'.repeat(64);
    expect(storagePathFor(UNIT_ID, 2, { path: 'learner.json', sha256: sha, kind: 'content' })).toBe(
      `units/${UNIT_ID}/2/learner.json`,
    );
    expect(storagePathFor(UNIT_ID, 2, { path: 'media/x.png', sha256: sha, kind: 'media' })).toBe(
      `blobs/${sha}`,
    );
  });

  it('only knows the content types the bucket allows', () => {
    expect(contentTypeFor('learner.json')).toBe('application/json');
    expect(contentTypeFor('audio/a.m4a')).toBe('audio/mp4');
    expect(() => contentTypeFor('media/x.svg')).toThrow(/unsupported/);
    expect(() => contentTypeFor('script.js')).toThrow(/unsupported/);
  });
});

describe('refusals', () => {
  it('refuses content that does not parse, and bad ids or versions', async () => {
    const base = { unitId: UNIT_ID, versionNo: 1, minAppVersion: '1.0.0' };
    await expect(buildPack({ ...base, content: { kind: 'lesson' } })).rejects.toThrow();
    await expect(buildPack({ ...base, content: null })).rejects.toThrow();
    await expect(buildPack({ ...base, unitId: 'nope', content: goldenUnit2 })).rejects.toThrow(
      /UUID/,
    );
    await expect(buildPack({ ...base, versionNo: 0, content: goldenUnit2 })).rejects.toThrow(
      /versionNo/,
    );
    await expect(
      buildPack({ ...base, minAppVersion: 'latest', content: goldenUnit2 }),
    ).rejects.toThrow();
  });

  it('produces a manifest that the device-side schema accepts', async () => {
    const built = await buildPack({
      unitId: UNIT_ID,
      versionNo: 1,
      minAppVersion: '1.0.0',
      content: goldenUnit2,
    });
    const manifestBytes = built.objects.at(-1)?.bytes;
    expect(PackManifest.parse(JSON.parse(decode(manifestBytes)))).toEqual(built.manifest);
  });
});
