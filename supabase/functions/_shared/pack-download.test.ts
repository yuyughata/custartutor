import { describe, expect, it, vi } from 'vitest';
import { goldenUnit2 } from '../../../packages/content-schema/src/fixtures';
import { PackDownload } from '../../../packages/learner-core/src/wire';
import { HttpError } from './http';
import { buildPack } from './pack-builder';
import {
  URL_TTL_SECONDS,
  buildDownload,
  parseAuthorizedPack,
  parseDownloadRequest,
  parseStoredManifest,
  signedPathsOf,
} from './pack-download';
import type { SignedUrl } from './pack-download';
import { manifestStoragePath } from './pack-layout';

const UNIT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_UNIT = '22222222-2222-4222-8222-222222222222';
const encode = (text: string) => new TextEncoder().encode(text);

async function sample(versionNo = 3) {
  const built = await buildPack({
    unitId: UNIT_ID,
    versionNo,
    minAppVersion: '1.0.0',
    content: goldenUnit2,
    media: [{ assetId: 'zari', bytes: encode('png-bytes'), ext: 'png' }],
  });
  const authorised = { manifest_path: built.manifestPath, content_hash: built.contentHash };
  const manifestText = JSON.stringify(built.manifest);
  return { built, authorised, manifestText };
}

const sign = (paths: string[]): SignedUrl[] =>
  paths.map((path) => ({
    path,
    signedUrl: `https://x.supabase.co/sign/${path}?token=t`,
    error: null,
  }));

function expectHttp(fn: () => unknown, status: number, code: string) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status, code });
    return;
  }
  throw new Error('expected an HttpError');
}

describe('parseDownloadRequest', () => {
  it('accepts the wire arguments and lower-cases the id', () => {
    expect(parseDownloadRequest({ p_unit_id: UNIT_ID.toUpperCase(), p_version_no: 2 })).toEqual({
      unitId: UNIT_ID,
      versionNo: 2,
    });
  });

  it('rejects anything else with a 400', () => {
    expectHttp(() => parseDownloadRequest({ p_version_no: 1 }), 400, 'invalid_unit_id');
    expectHttp(
      () => parseDownloadRequest({ p_unit_id: 'nope', p_version_no: 1 }),
      400,
      'invalid_unit_id',
    );
    expectHttp(
      () => parseDownloadRequest({ p_unit_id: `${UNIT_ID}/../x`, p_version_no: 1 }),
      400,
      'invalid_unit_id',
    );
    expectHttp(() => parseDownloadRequest({ p_unit_id: UNIT_ID }), 400, 'invalid_version_no');
    expectHttp(
      () => parseDownloadRequest({ p_unit_id: UNIT_ID, p_version_no: 0 }),
      400,
      'invalid_version_no',
    );
    expectHttp(
      () => parseDownloadRequest({ p_unit_id: UNIT_ID, p_version_no: 1.5 }),
      400,
      'invalid_version_no',
    );
    expectHttp(
      () => parseDownloadRequest({ p_unit_id: UNIT_ID, p_version_no: '1' }),
      400,
      'invalid_version_no',
    );
  });
});

describe('parseAuthorizedPack', () => {
  it('only accepts the canonical manifest path of the asked unit and version', () => {
    const hash = 'a'.repeat(64);
    const path = manifestStoragePath(UNIT_ID, 3);
    expect(parseAuthorizedPack({ manifest_path: path, content_hash: hash }, UNIT_ID, 3)).toEqual({
      manifest_path: path,
      content_hash: hash,
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const bad of [
      { manifest_path: manifestStoragePath(OTHER_UNIT, 3), content_hash: hash },
      { manifest_path: manifestStoragePath(UNIT_ID, 4), content_hash: hash },
      { manifest_path: 'units/../secret.json', content_hash: hash },
      { manifest_path: path, content_hash: 'short' },
      { manifest_path: path },
      null,
      'x',
    ]) {
      expectHttp(() => parseAuthorizedPack(bad, UNIT_ID, 3), 500, 'internal_error');
    }
  });
});

describe('parseStoredManifest', () => {
  it('returns the manifest the database authorised', async () => {
    const { built, authorised, manifestText } = await sample();
    expect(parseStoredManifest(manifestText, authorised, UNIT_ID, 3)).toEqual(built.manifest);
  });

  it('refuses a manifest of another unit, version or content (a corrupt pack)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { built, authorised, manifestText } = await sample();
    expectHttp(
      () => parseStoredManifest(manifestText, authorised, OTHER_UNIT, 3),
      500,
      'pack_corrupt',
    );
    expectHttp(
      () => parseStoredManifest(manifestText, authorised, UNIT_ID, 4),
      500,
      'pack_corrupt',
    );
    expectHttp(
      () =>
        parseStoredManifest(
          manifestText,
          { ...authorised, content_hash: 'b'.repeat(64) },
          UNIT_ID,
          3,
        ),
      500,
      'pack_corrupt',
    );
    const hostile = JSON.stringify({
      ...built.manifest,
      files: built.manifest.files.map((f, i) =>
        i === 0 ? { ...f, path: '../../other/learner.json' } : f,
      ),
    });
    expectHttp(() => parseStoredManifest(hostile, authorised, UNIT_ID, 3), 500, 'pack_corrupt');
    expectHttp(() => parseStoredManifest('not json', authorised, UNIT_ID, 3), 500, 'pack_corrupt');
    expectHttp(() => parseStoredManifest('{}', authorised, UNIT_ID, 3), 500, 'pack_corrupt');
  });
});

describe('signedPathsOf and buildDownload', () => {
  it('signs every file of both packs once, by storage path', async () => {
    const { built } = await sample();
    const paths = signedPathsOf(built.manifest);
    expect(paths).toContain(`units/${UNIT_ID}/3/learner.json`);
    expect(paths).toContain(`units/${UNIT_ID}/3/grownup.json`);
    const blob = built.manifest.files.find((f) => f.kind === 'media');
    expect(paths).toContain(`blobs/${blob?.sha256}`);
    expect(paths).not.toContain(`units/${UNIT_ID}/3/manifest.json`);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('returns exactly the PackDownload of the wire contract, keyed by manifest path', async () => {
    const { built } = await sample();
    const now = Date.parse('2026-10-12T10:00:00.000Z');
    const body = buildDownload(
      built.manifest,
      sign(signedPathsOf(built.manifest)),
      URL_TTL_SECONDS,
      now,
    );

    expect(Object.keys(body).sort()).toEqual(['expires_at', 'manifest', 'urls']);
    expect(body.expires_at).toBe('2026-10-12T12:00:00.000Z');
    expect(Object.keys(body.urls).sort()).toEqual(built.manifest.files.map((f) => f.path).sort());
    expect(body.urls['learner.json']).toContain(`units/${UNIT_ID}/3/learner.json`);
    const media = built.manifest.files.find((f) => f.kind === 'media');
    expect(body.urls[media?.path ?? '']).toContain(`blobs/${media?.sha256}`);
    // the same schema the app parses the response with
    expect(PackDownload.safeParse(body).success).toBe(true);
    expect(URL_TTL_SECONDS).toBeGreaterThanOrEqual(3600);
  });

  it('fails (502) when a file could not be signed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { built } = await sample();
    const paths = signedPathsOf(built.manifest);
    const missing = sign(paths.slice(1));
    expectHttp(() => buildDownload(built.manifest, missing, 7200, 0), 502, 'pack_unavailable');
    const errored = sign(paths).map((s, i) => (i === 0 ? { ...s, error: 'Object not found' } : s));
    expectHttp(() => buildDownload(built.manifest, errored, 7200, 0), 502, 'pack_unavailable');
  });
});
