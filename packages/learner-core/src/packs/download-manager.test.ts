import { parseUnit } from '@custar/content-schema';
import type { PackManifest, UnitContent } from '@custar/content-schema';
import { goldenUnit2, marketDayMathsUnit } from '@custar/content-schema/fixtures';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncApiError } from '../api';
import { getActivePack, listPackFiles } from '../db/packs';
import { LessonSession } from '../session';
import {
  DiskSpaceError,
  DownloadError,
  IntegrityError,
  NetworkPolicyError,
  PackNotFoundError,
  PackTooNewError,
} from '../errors';
import { buildPackFiles } from '../fakes/pack-builder';
import type { BuiltPack, PackMedia } from '../fakes/pack-builder';
import { encodeUtf8 } from '../utf8';
import { UNIT_1, UNIT_2, CHILD_A } from '../test-helpers';
import { createTestPorts } from '../testing';
import type { TestPorts } from '../testing';
import { DownloadManager } from './download-manager';
import { packStatuses } from './status';
import { blobPath, manifestPath } from './paths';
import { correctResponse } from '../fakes/answers';

const lesson = parseUnit(goldenUnit2);
const maths = parseUnit(marketDayMathsUnit);

let ports: TestPorts;
let manager: DownloadManager;

function bytes(length: number, salt: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = (i * 31 + salt * 17 + (i >> 8)) & 0xff;
  return out;
}

const PICTURE: PackMedia = { assetId: 'picture', bytes: bytes(20_000, 1), ext: 'webp' };
const AUDIO: PackMedia = {
  assetId: 'narration',
  bytes: bytes(30_000, 2),
  ext: 'mp3',
  kind: 'audio',
};

async function publish(
  unit: UnitContent,
  unitId: string,
  versionNo: number,
  media: PackMedia[] = [PICTURE, AUDIO],
  minAppVersion = '1.0.0',
): Promise<BuiltPack> {
  const pack = await buildPackFiles(unit, { unitId, versionNo, media, minAppVersion });
  ports.api.publishPack(pack);
  return pack;
}

function newManager(over: { appVersion?: string; diskMarginBytes?: number } = {}): DownloadManager {
  return new DownloadManager({
    ports,
    api: ports.api,
    network: ports.network,
    appVersion: over.appVersion ?? '1.5.0',
    ...(over.diskMarginBytes !== undefined ? { diskMarginBytes: over.diskMarginBytes } : {}),
  });
}

async function urlOf(unitId: string, versionNo: number, path: string): Promise<string> {
  const grant = await ports.api.getPackDownload(unitId, versionNo);
  return grant.urls[path] ?? '';
}

beforeEach(async () => {
  ports = await createTestPorts({ seed: 'packs' });
  manager = newManager();
});

describe('downloadUnit: the happy path', () => {
  it('downloads both packs and media, verifies, stores and activates', async () => {
    const pack = await publish(lesson, UNIT_1, 1);
    const report = await manager.downloadUnit(UNIT_1, 1);

    expect(report).toMatchObject({
      unitId: UNIT_1,
      versionNo: 1,
      filesDownloaded: 4,
      filesReused: 0,
      supersededVersionNo: null,
      urlGrants: 1,
    });
    expect(report.bytesDownloaded).toBe(pack.manifest.files.reduce((n, f) => n + f.bytes, 0));

    const stored = ports.files.list().filter((p) => !p.endsWith('.part'));
    const sha = (path: string) => pack.manifest.files.find((f) => f.path === path)?.sha256 ?? '';
    expect(stored).toEqual(
      [
        'packs/' + UNIT_1 + '/1/learner.json',
        'packs/' + UNIT_1 + '/1/grownup.json',
        manifestPath(UNIT_1, 1),
        blobPath(sha('media/picture.webp')),
        blobPath(sha('audio/narration.mp3')),
      ].sort(),
    );
    expect((await listPackFiles(ports.db, UNIT_1, 1)).every((r) => r.state === 'verified')).toBe(
      true,
    );
    expect(await getActivePack(ports.db, UNIT_1)).toMatchObject({
      version_no: 1,
      superseded_version_no: null,
    });
  });

  it('JSON content is stored uncompressed, byte for byte', async () => {
    const pack = await publish(lesson, UNIT_1, 1);
    await manager.downloadUnit(UNIT_1, 1);
    const onDisk = await ports.files.readBytes(`packs/${UNIT_1}/1/learner.json`);
    expect(Array.from(onDisk)).toEqual(Array.from(pack.files.get('learner.json') ?? []));
    expect(() => JSON.parse(new TextDecoder().decode(onDisk))).not.toThrow();
  });

  it('loads the active lesson, resolves assets, reads the grown-up pack and plays', async () => {
    await publish(lesson, UNIT_1, 1);
    await manager.downloadUnit(UNIT_1, 1);
    const loaded = await manager.loadActiveLesson(UNIT_1);
    expect(loaded.unit.kind).toBe('lesson');
    expect(loaded.versionNo).toBe(1);
    expect(loaded.assetPath('picture')).toMatch(/^blobs\/[0-9a-f]{64}$/);
    expect(await ports.files.exists(loaded.assetPath('narration') ?? '')).toBe(true);
    expect(loaded.assetPath('missing')).toBeNull();

    const grownup = await manager.loadGrownupContent(UNIT_1);
    expect(grownup?.teacher_manual.helper_script.length).toBeGreaterThan(0);

    const session = new LessonSession({
      unit: loaded.unit,
      unitId: UNIT_1,
      versionNo: loaded.versionNo,
      childId: CHILD_A,
      ports,
    });
    for (const id of session.masteryQuestions()) {
      await session.answer(id, correctResponse(loaded.unit.questions[id]!));
    }
    expect((await session.submitMasteryCheck()).passed).toBe(true);
  });

  it('can skip the grown-up pack', async () => {
    await publish(lesson, UNIT_1, 1);
    const report = await manager.downloadUnit(UNIT_1, 1, { includeGrownup: false });
    expect(report.filesDownloaded).toBe(3);
    expect(await ports.files.exists(`packs/${UNIT_1}/1/grownup.json`)).toBe(false);
    expect(await manager.loadGrownupContent(UNIT_1)).toBeNull();
  });

  it('reports progress', async () => {
    await publish(lesson, UNIT_1, 1);
    const seen: number[] = [];
    await manager.downloadUnit(UNIT_1, 1, { onProgress: (p) => seen.push(p.bytesDone) });
    expect(seen).toHaveLength(4);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });

  it('is a no-op the second time (everything verified, nothing fetched)', async () => {
    await publish(lesson, UNIT_1, 1);
    await manager.downloadUnit(UNIT_1, 1);
    const requests = ports.downloader.requests.length;
    const again = await manager.downloadUnit(UNIT_1, 1);
    expect(again.bytesDownloaded).toBe(0);
    expect(again.filesDownloaded).toBe(0);
    expect(ports.downloader.requests.length).toBe(requests);
    expect(again.supersededVersionNo).toBeNull();
  });
});

describe('interrupted and resumed downloads', () => {
  it('records the partial file, then resumes with a Range request', async () => {
    const pack = await publish(lesson, UNIT_1, 1);
    const url = await urlOf(UNIT_1, 1, 'audio/narration.mp3');
    ports.downloader.failAfter(url, 12_345);

    const failure = await manager.downloadUnit(UNIT_1, 1).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(DownloadError);
    expect((failure as DownloadError).path).toBe('audio/narration.mp3');

    const row = (await listPackFiles(ports.db, UNIT_1, 1)).find(
      (r) => r.path === 'audio/narration.mp3',
    );
    expect(row).toMatchObject({ state: 'partial', downloaded_bytes: 12_345 });
    expect(await getActivePack(ports.db, UNIT_1)).toBeNull(); // never half-activated

    const report = await manager.downloadUnit(UNIT_1, 1);
    const resumed = ports.downloader.requests.filter((r) => r.url === url).at(-1);
    expect(resumed).toMatchObject({ rangeStart: 12_345, status: 206 });
    expect(report.bytesDownloaded).toBeLessThan(
      pack.manifest.files.reduce((n, f) => n + f.bytes, 0),
    );
    expect((await listPackFiles(ports.db, UNIT_1, 1)).every((r) => r.state === 'verified')).toBe(
      true,
    );
    expect(await getActivePack(ports.db, UNIT_1)).toMatchObject({ version_no: 1 });
    expect(await ports.files.exists('blobs/' + pack.manifest.files[3]?.sha256 + '.part')).toBe(
      false,
    );
  });

  it('restarts from scratch when the server ignores Range', async () => {
    await publish(lesson, UNIT_1, 1);
    const url = await urlOf(UNIT_1, 1, 'audio/narration.mp3');
    ports.downloader.failAfter(url, 5000);
    await expect(manager.downloadUnit(UNIT_1, 1)).rejects.toBeInstanceOf(DownloadError);
    ports.downloader.supportsRange = false;
    await manager.downloadUnit(UNIT_1, 1);
    expect(ports.downloader.requests.filter((r) => r.url === url).at(-1)).toMatchObject({
      status: 200,
    });
    expect((await listPackFiles(ports.db, UNIT_1, 1)).every((r) => r.state === 'verified')).toBe(
      true,
    );
  });

  it('recovers when the partial file is garbage: sha mismatch, delete, download once more', async () => {
    const pack = await publish(lesson, UNIT_1, 1);
    const file = pack.manifest.files.find((f) => f.path === 'audio/narration.mp3')!;
    await ports.files.writeBytes(blobPath(file.sha256) + '.part', bytes(1000, 99)); // wrong bytes
    const report = await manager.downloadUnit(UNIT_1, 1);
    const url = await urlOf(UNIT_1, 1, 'audio/narration.mp3');
    const forFile = ports.downloader.requests.filter((r) => r.url === url);
    expect(forFile.map((r) => r.status)).toEqual([206, 200]); // resumed (bad), then fresh
    expect(report.filesDownloaded).toBe(4);
    expect(await ports.files.size(blobPath(file.sha256))).toBe(file.bytes);
  });

  it('starts over when the partial file is longer than the real one (HTTP 416)', async () => {
    const pack = await publish(lesson, UNIT_1, 1);
    const file = pack.manifest.files.find((f) => f.path === 'media/picture.webp')!;
    await ports.files.writeBytes(blobPath(file.sha256) + '.part', bytes(file.bytes + 500, 3));
    const report = await manager.downloadUnit(UNIT_1, 1);
    const url = await urlOf(UNIT_1, 1, 'media/picture.webp');
    expect(ports.downloader.requests.filter((r) => r.url === url).map((r) => r.status)).toEqual([
      416, 200,
    ]);
    expect(report.filesDownloaded).toBe(4);
    expect(await ports.files.size(blobPath(file.sha256))).toBe(file.bytes);
  });

  it('re-fetches a file whose manifest entry changed for the same version', async () => {
    await publish(lesson, UNIT_1, 1);
    await manager.downloadUnit(UNIT_1, 1);
    const changed = { ...PICTURE, bytes: bytes(21_000, 8) };
    await publish(lesson, UNIT_1, 1, [changed, AUDIO]);
    const report = await manager.downloadUnit(UNIT_1, 1);
    expect(report.filesDownloaded).toBeGreaterThanOrEqual(1);
    const rows = await listPackFiles(ports.db, UNIT_1, 1);
    expect(rows.every((r) => r.state === 'verified')).toBe(true);
    const picture = rows.find((r) => r.path === 'media/picture.webp')!;
    expect(await ports.files.size(blobPath(picture.sha256))).toBe(21_000);
  });

  it('uses a file that finished downloading before the app could mark it verified', async () => {
    const pack = await publish(lesson, UNIT_1, 1);
    const file = pack.manifest.files.find((f) => f.path === 'media/picture.webp')!;
    await ports.files.writeBytes(blobPath(file.sha256), PICTURE.bytes); // on disk, no pack_file row yet
    const report = await manager.downloadUnit(UNIT_1, 1);
    const url = await urlOf(UNIT_1, 1, 'media/picture.webp');
    expect(ports.downloader.requests.some((r) => r.url === url)).toBe(false);
    expect(report.filesDownloaded).toBe(3);
    expect(report.filesReused).toBe(1);
  });
});

describe('integrity', () => {
  it('fails after one automatic re-download when the bytes keep hashing wrong', async () => {
    const pack = await publish(lesson, UNIT_1, 1);
    const tampered = bytes(PICTURE.bytes.length, 77); // same length, other content
    pack.files.set('media/picture.webp', tampered);

    const failure = await manager.downloadUnit(UNIT_1, 1).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(IntegrityError);
    expect((failure as IntegrityError).path).toBe('media/picture.webp');
    expect((failure as IntegrityError).expected).toBe(
      pack.manifest.files.find((f) => f.path === 'media/picture.webp')?.sha256,
    );

    const url = await urlOf(UNIT_1, 1, 'media/picture.webp');
    expect(ports.downloader.requests.filter((r) => r.url === url)).toHaveLength(2);
    const sha = pack.manifest.files.find((f) => f.path === 'media/picture.webp')!.sha256;
    expect(await ports.files.exists(blobPath(sha))).toBe(false); // the bad file was deleted
    expect(await getActivePack(ports.db, UNIT_1)).toBeNull();
  });

  it('succeeds when only the first attempt was corrupted', async () => {
    const pack = await publish(lesson, UNIT_1, 1);
    const good = pack.files.get('media/picture.webp')!;
    const spy = vi.spyOn(ports.api, 'resolveUrl');
    spy.mockImplementationOnce(() => ({ status: 200, body: bytes(good.length, 5) }));
    // the first resolved URL is learner.json, so corrupt that one: its hash is checked the same way
    const report = await manager.downloadUnit(UNIT_1, 1);
    expect(report.filesDownloaded).toBe(4);
    expect(ports.downloader.requests.length).toBe(5); // one file needed a second request
    expect((await listPackFiles(ports.db, UNIT_1, 1)).every((r) => r.state === 'verified')).toBe(
      true,
    );
  });

  it('refuses a manifest that describes another lesson', async () => {
    const pack = await publish(lesson, UNIT_1, 1);
    vi.spyOn(ports.api, 'getPackDownload').mockResolvedValue({
      manifest: { ...pack.manifest, unit_id: UNIT_2 },
      urls: {},
      expires_at: new Date(ports.clock.now() + 3_600_000).toISOString(),
    });
    await expect(manager.downloadUnit(UNIT_1, 1)).rejects.toBeInstanceOf(IntegrityError);
    expect(ports.downloader.requests).toEqual([]);
  });

  it('refuses a structurally broken manifest before fetching anything', async () => {
    const pack = await publish(lesson, UNIT_1, 1);
    const broken: PackManifest = { ...pack.manifest, learner_content_path: 'nope.json' };
    vi.spyOn(ports.api, 'getPackDownload').mockResolvedValue({
      manifest: broken,
      urls: Object.fromEntries(broken.files.map((f) => [f.path, `https://x.test/${f.path}`])),
      expires_at: new Date(ports.clock.now() + 3_600_000).toISOString(),
    });
    await expect(manager.downloadUnit(UNIT_1, 1)).rejects.toThrow(/Invalid lesson manifest/);
    expect(ports.downloader.requests).toEqual([]);
  });

  it('refuses a pack whose hash differs from what the sync announced', async () => {
    await publish(lesson, UNIT_1, 1);
    await ports.db.run(
      `INSERT INTO published (unit_id, version_no, schema_version, content_hash, min_app_version, pack_manifest_path)
       VALUES (?, 1, 1, ?, '1.0.0', 'x')`,
      [UNIT_1, 'f'.repeat(64)],
    );
    await expect(manager.downloadUnit(UNIT_1, 1)).rejects.toBeInstanceOf(IntegrityError);
    expect(ports.downloader.requests).toEqual([]);
  });

  it('rejects a malformed grant as a protocol error', async () => {
    vi.spyOn(ports.api, 'getPackDownload').mockResolvedValue({} as never);
    await expect(manager.downloadUnit(UNIT_1, 1)).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('notices a stored file that was damaged after activation', async () => {
    await publish(lesson, UNIT_1, 1);
    await manager.downloadUnit(UNIT_1, 1);
    await ports.files.writeText(`packs/${UNIT_1}/1/learner.json`, '{"truncated": ');
    await expect(manager.loadActiveUnit(UNIT_1)).rejects.toBeInstanceOf(IntegrityError);
    // downloading again repairs it (size no longer matches, so the file is fetched again)
    await manager.downloadUnit(UNIT_1, 1);
    await expect(manager.loadActiveUnit(UNIT_1)).resolves.toBeDefined();
  });
});

describe('disk space', () => {
  it('refuses before writing anything when free space < bytes + 50 MB', async () => {
    const pack = await publish(lesson, UNIT_1, 1);
    const total = pack.manifest.files.reduce((n, f) => n + f.bytes, 0);
    const margin = 50 * 1024 * 1024;
    ports.files.setCapacity(total + margin - 1);

    const failure = await manager.downloadUnit(UNIT_1, 1).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(DiskSpaceError);
    expect(failure).toMatchObject({ neededBytes: total + margin, freeBytes: total + margin - 1 });
    expect(ports.files.list()).toEqual([]);
    expect(await ports.db.all('SELECT * FROM pack_file')).toEqual([]);
    expect(ports.downloader.requests).toEqual([]);
  });

  it('proceeds when there is exactly enough', async () => {
    const pack = await publish(lesson, UNIT_1, 1);
    const total = pack.manifest.files.reduce((n, f) => n + f.bytes, 0);
    ports.files.setCapacity(total + 50 * 1024 * 1024 + 4096);
    await expect(manager.downloadUnit(UNIT_1, 1)).resolves.toMatchObject({ versionNo: 1 });
  });

  it('counts only the bytes still to fetch, and honours a custom margin', async () => {
    await publish(lesson, UNIT_1, 1);
    const small = newManager({ diskMarginBytes: 1000 });
    ports.files.setCapacity(10_000); // far below the pack size
    await expect(small.downloadUnit(UNIT_1, 1)).rejects.toBeInstanceOf(DiskSpaceError);

    ports.files.setCapacity(1_000_000);
    await small.downloadUnit(UNIT_1, 1);
    // everything is already here: a full disk no longer matters
    ports.files.setCapacity(ports.files.usedBytes());
    await expect(small.downloadUnit(UNIT_1, 1)).resolves.toMatchObject({ filesDownloaded: 0 });
  });
});

describe('network policy', () => {
  it('refuses when offline', async () => {
    await publish(lesson, UNIT_1, 1);
    ports.network.online = false;
    const failure = await manager.downloadUnit(UNIT_1, 1).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(NetworkPolicyError);
    expect((failure as NetworkPolicyError).reason).toBe('offline');
    expect(ports.api.calls.getPackDownload).toBe(0);
  });

  it('honours wifiOnly on a metered connection but allows it otherwise', async () => {
    await publish(lesson, UNIT_1, 1);
    ports.network.unmetered = false;
    const failure = await manager
      .downloadUnit(UNIT_1, 1, { wifiOnly: true })
      .catch((e: unknown) => e);
    expect((failure as NetworkPolicyError).reason).toBe('metered');
    expect(ports.api.calls.getPackDownload).toBe(0);
    await expect(manager.downloadUnit(UNIT_1, 1)).resolves.toMatchObject({ versionNo: 1 });
  });
});

describe('expired signed URLs', () => {
  it('re-requests the URLs once and carries on', async () => {
    await publish(lesson, UNIT_1, 1);
    let first = true;
    const report = await manager.downloadUnit(UNIT_1, 1, {
      onProgress: () => {
        if (first) {
          first = false;
          ports.api.expireSignedUrls(); // the links die after the first file
        }
      },
    });
    expect(report.urlGrants).toBe(2);
    expect(ports.api.calls.getPackDownload).toBe(2);
    const statuses = ports.downloader.requests.map((r) => r.status);
    expect(statuses).toContain(403);
    expect((await listPackFiles(ports.db, UNIT_1, 1)).every((r) => r.state === 'verified')).toBe(
      true,
    );
  });

  it('gives up after a single renewal if the new links are rejected too', async () => {
    await publish(lesson, UNIT_1, 1);
    ports.api.breakSignedUrls(true);
    const failure = await manager.downloadUnit(UNIT_1, 1).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(DownloadError);
    expect((failure as DownloadError).status).toBe(403);
    expect(ports.api.calls.getPackDownload).toBe(2); // the grant plus exactly one renewal
    expect(await getActivePack(ports.db, UNIT_1)).toBeNull();
  });

  it('surfaces a server error while renewing', async () => {
    await publish(lesson, UNIT_1, 1);
    ports.api.breakSignedUrls(true);
    ports.api.failOnCall('getPackDownload', 2, new SyncApiError('offline'));
    await expect(manager.downloadUnit(UNIT_1, 1)).rejects.toMatchObject({ code: 'offline' });
  });
});

describe('app version', () => {
  it('refuses to download a pack that needs a newer app, before fetching a byte', async () => {
    await publish(lesson, UNIT_1, 1, [PICTURE], '2.0.0');
    const failure = await manager.downloadUnit(UNIT_1, 1).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(PackTooNewError);
    expect(failure).toMatchObject({ minAppVersion: '2.0.0', appVersion: '1.5.0' });
    expect(ports.downloader.requests).toEqual([]);
  });

  it('refuses to load an active pack once the app is older than its min_app_version', async () => {
    await publish(lesson, UNIT_1, 1, [PICTURE], '1.4.0');
    await manager.downloadUnit(UNIT_1, 1);
    await expect(manager.loadActiveUnit(UNIT_1)).resolves.toBeDefined();
    const older = newManager({ appVersion: '1.3.9' });
    await expect(older.loadActiveUnit(UNIT_1)).rejects.toBeInstanceOf(PackTooNewError);
    expect(newManager({ appVersion: '1.10.0' })).toBeDefined();
    await expect(
      newManager({ appVersion: '1.10.0' }).loadActiveUnit(UNIT_1),
    ).resolves.toBeDefined();
  });

  it('reports a missing pack', async () => {
    await expect(manager.loadActiveUnit(UNIT_1)).rejects.toBeInstanceOf(PackNotFoundError);
  });

  it('degrades block types it does not know instead of failing', async () => {
    const pack = await publish(lesson, UNIT_1, 1);
    const raw = JSON.parse(new TextDecoder().decode(pack.files.get('learner.json')));
    raw.sections[0].blocks.push({ type: 'hologram', depth: 3 });
    const edited = encodeUtf8(JSON.stringify(raw));
    const hasher = ports.hasher;
    pack.files.set('learner.json', edited);
    const entry = pack.manifest.files.find((f) => f.path === 'learner.json')!;
    entry.bytes = edited.length;
    entry.sha256 = await hasher.sha256Hex(edited);
    await manager.downloadUnit(UNIT_1, 1);
    const loaded = await manager.loadActiveUnit(UNIT_1);
    const blocks = loaded.unit.kind === 'lesson' ? loaded.unit.sections[0]!.blocks : [];
    expect(blocks.at(-1)).toMatchObject({ type: 'unknown', original_type: 'hologram' });
  });
});

describe('atomic swap and release', () => {
  const sharedPicture = PICTURE;
  const newAudio: PackMedia = {
    assetId: 'narration',
    bytes: bytes(31_000, 3),
    ext: 'mp3',
    kind: 'audio',
  };

  async function downloadV1ThenPublishV2(): Promise<{ v1: BuiltPack; v2: BuiltPack }> {
    const v1 = await publish(lesson, UNIT_1, 1, [sharedPicture, AUDIO]);
    await manager.downloadUnit(UNIT_1, 1);
    const v2 = await publish(lesson, UNIT_1, 2, [sharedPicture, newAudio]);
    return { v1, v2 };
  }

  it('keeps the old version on disk and playable until the new one is fully verified', async () => {
    const { v1 } = await downloadV1ThenPublishV2();
    const session = await manager.loadActiveLesson(UNIT_1); // a child is mid-session on v1
    expect(session.versionNo).toBe(1);

    // v2 download dies half way: v1 is still the active pack and fully intact
    const url = await urlOf(UNIT_1, 2, 'audio/narration.mp3');
    ports.downloader.failAfter(url, 1000);
    await expect(manager.downloadUnit(UNIT_1, 2)).rejects.toBeInstanceOf(DownloadError);
    expect(await getActivePack(ports.db, UNIT_1)).toMatchObject({
      version_no: 1,
      superseded_version_no: null,
    });
    expect((await manager.loadActiveLesson(UNIT_1)).versionNo).toBe(1);

    // retry succeeds: the pointer flips in one step and v1 is recorded as superseded
    const report = await manager.downloadUnit(UNIT_1, 2);
    expect(report.supersededVersionNo).toBe(1);
    expect(await getActivePack(ports.db, UNIT_1)).toMatchObject({
      version_no: 2,
      superseded_version_no: 1,
    });
    expect((await manager.loadActiveLesson(UNIT_1)).versionNo).toBe(2);

    // v1 is still entirely on disk for the running session
    expect(await ports.files.exists(`packs/${UNIT_1}/1/learner.json`)).toBe(true);
    const oldAudio = v1.manifest.files.find((f) => f.path === 'audio/narration.mp3')!;
    expect(await ports.files.exists(blobPath(oldAudio.sha256))).toBe(true);
    // the shared picture was reused, not downloaded again
    const pictureUrl = await urlOf(UNIT_1, 2, 'media/picture.webp');
    expect(ports.downloader.requests.some((r) => r.url === pictureUrl)).toBe(false);
  });

  it('releases only what the active version does not need', async () => {
    const { v1, v2 } = await downloadV1ThenPublishV2();
    await manager.downloadUnit(UNIT_1, 2);

    const released = await manager.releaseSuperseded(UNIT_1);
    expect(released.versions).toEqual([1]);

    const picture = v1.manifest.files.find((f) => f.path === 'media/picture.webp')!;
    const oldAudio = v1.manifest.files.find((f) => f.path === 'audio/narration.mp3')!;
    const newAudioSha = v2.manifest.files.find((f) => f.path === 'audio/narration.mp3')!.sha256;
    expect(await ports.files.exists(`packs/${UNIT_1}/1/learner.json`)).toBe(false);
    expect(await ports.files.exists(manifestPath(UNIT_1, 1))).toBe(false);
    expect(await ports.files.exists(blobPath(oldAudio.sha256))).toBe(false); // exclusive to v1: gone
    expect(await ports.files.exists(blobPath(picture.sha256))).toBe(true); // shared with v2: kept
    expect(await ports.files.exists(blobPath(newAudioSha))).toBe(true);
    expect(await listPackFiles(ports.db, UNIT_1, 1)).toEqual([]);
    expect(await getActivePack(ports.db, UNIT_1)).toMatchObject({
      version_no: 2,
      superseded_version_no: null,
    });
    expect((await manager.loadActiveLesson(UNIT_1)).assetPath('picture')).toBe(
      blobPath(picture.sha256),
    );

    expect(await manager.releaseSuperseded(UNIT_1)).toMatchObject({ versions: [] }); // idempotent
  });

  it('releases an unreleased older swap before making another', async () => {
    await downloadV1ThenPublishV2();
    await manager.downloadUnit(UNIT_1, 2);
    await publish(lesson, UNIT_1, 3, [sharedPicture, newAudio]);
    const report = await manager.downloadUnit(UNIT_1, 3);
    expect(report.supersededVersionNo).toBe(2);
    expect(await ports.files.exists(`packs/${UNIT_1}/1/learner.json`)).toBe(false); // v1 released
    expect(await ports.files.exists(`packs/${UNIT_1}/2/learner.json`)).toBe(true); // v2 superseded, kept
    expect(await getActivePack(ports.db, UNIT_1)).toMatchObject({
      version_no: 3,
      superseded_version_no: 2,
    });
  });

  it('never deletes a blob another unit still uses', async () => {
    const a = await publish(lesson, UNIT_1, 1, [sharedPicture]);
    await publish(maths, UNIT_2, 1, [sharedPicture]);
    await manager.downloadUnit(UNIT_1, 1);
    await manager.downloadUnit(UNIT_2, 1);
    const sha = a.manifest.files.find((f) => f.kind === 'media')!.sha256;
    // the second unit found the blob already on disk
    const url2 = await urlOf(UNIT_2, 1, 'media/picture.webp');
    expect(ports.downloader.requests.some((r) => r.url === url2)).toBe(false);

    await manager.removeUnit(UNIT_1);
    expect(await ports.files.exists(blobPath(sha))).toBe(true);
    expect(await ports.files.exists(`packs/${UNIT_1}/1/learner.json`)).toBe(false);
    expect(await getActivePack(ports.db, UNIT_1)).toBeNull();
    await expect(manager.loadActiveUnit(UNIT_2)).resolves.toBeDefined();

    await manager.removeUnit(UNIT_2);
    expect(await ports.files.exists(blobPath(sha))).toBe(false);
    expect(ports.files.list()).toEqual([]);
    expect(await ports.db.all('SELECT * FROM pack_file')).toEqual([]);
  });

  it('removeUnit also clears half-finished downloads and their .part files', async () => {
    await publish(lesson, UNIT_1, 1);
    const url = await urlOf(UNIT_1, 1, 'audio/narration.mp3');
    ports.downloader.failAfter(url, 4000);
    await expect(manager.downloadUnit(UNIT_1, 1)).rejects.toBeInstanceOf(DownloadError);
    expect(ports.files.list().some((p) => p.endsWith('.part'))).toBe(true);
    await manager.removeUnit(UNIT_1);
    expect(ports.files.list()).toEqual([]);
  });

  it('drops abandoned half-downloads of versions the server has replaced', async () => {
    await publish(lesson, UNIT_1, 1);
    const url = await urlOf(UNIT_1, 1, 'audio/narration.mp3');
    ports.downloader.failAfter(url, 4000);
    await expect(manager.downloadUnit(UNIT_1, 1)).rejects.toBeInstanceOf(DownloadError);
    await publish(lesson, UNIT_1, 2, [PICTURE, newAudio]);
    await manager.downloadUnit(UNIT_1, 2);
    expect(await listPackFiles(ports.db, UNIT_1, 1)).toEqual([]);
    expect(ports.files.list().some((p) => p.endsWith('.part'))).toBe(false);
  });
});

describe('storage usage', () => {
  it('counts shared blobs once and labels each version', async () => {
    const a = await publish(lesson, UNIT_1, 1, [PICTURE]);
    await publish(maths, UNIT_2, 1, [PICTURE]);
    await manager.downloadUnit(UNIT_1, 1);
    await manager.downloadUnit(UNIT_2, 1);
    const usage = await manager.storageUsage();
    expect(usage.versions).toHaveLength(2);
    expect(usage.versions.every((v) => v.role === 'active')).toBe(true);
    const own = (unitId: string) => usage.versions.find((v) => v.unitId === unitId)!.bytes;
    expect(usage.totalBytes).toBe(own(UNIT_1) + own(UNIT_2) - PICTURE.bytes.length);
    expect(usage.freeBytes).toBeGreaterThan(0);
    expect(a.manifest.files.length).toBe(3);
  });

  it('shows an unfinished download as partial', async () => {
    await publish(lesson, UNIT_1, 1);
    ports.downloader.failAfter(await urlOf(UNIT_1, 1, 'audio/narration.mp3'), 7000);
    await expect(manager.downloadUnit(UNIT_1, 1)).rejects.toBeInstanceOf(DownloadError);
    const usage = await manager.storageUsage();
    expect(usage.versions[0]).toMatchObject({ role: 'partial' });
    expect(usage.totalBytes).toBeGreaterThanOrEqual(7000);
  });
});

describe('concurrency', () => {
  it('shares one run between identical simultaneous requests', async () => {
    await publish(lesson, UNIT_1, 1);
    const first = manager.downloadUnit(UNIT_1, 1);
    const second = manager.downloadUnit(UNIT_1, 1);
    expect(second).toBe(first);
    await first;
    expect(ports.api.calls.getPackDownload).toBe(1);
    expect(ports.downloader.requests).toHaveLength(4);
  });

  it('queues removal behind a running download of the same unit', async () => {
    await publish(lesson, UNIT_1, 1);
    const download = manager.downloadUnit(UNIT_1, 1);
    const removal = manager.removeUnit(UNIT_1);
    const [, removed] = await Promise.all([download, removal]);
    expect(removed.filesRemoved).toBeGreaterThan(0);
    expect(ports.files.list()).toEqual([]);
    expect(await getActivePack(ports.db, UNIT_1)).toBeNull();
    expect(await ports.db.all('SELECT * FROM pack_file')).toEqual([]);
  });

  it('downloads different units side by side', async () => {
    await publish(lesson, UNIT_1, 1);
    await publish(maths, UNIT_2, 1);
    const [a, b] = await Promise.all([
      manager.downloadUnit(UNIT_1, 1),
      manager.downloadUnit(UNIT_2, 1),
    ]);
    expect([a.unitId, b.unitId]).toEqual([UNIT_1, UNIT_2]);
  });

  it('lets a failed download be retried', async () => {
    await publish(lesson, UNIT_1, 1);
    ports.downloader.failAfter(await urlOf(UNIT_1, 1, 'learner.json'), 10);
    await expect(manager.downloadUnit(UNIT_1, 1)).rejects.toBeInstanceOf(DownloadError);
    await expect(manager.downloadUnit(UNIT_1, 1)).resolves.toMatchObject({ versionNo: 1 });
  });
});

describe('packStatuses', () => {
  async function announce(unitId: string, versionNo: number): Promise<void> {
    await ports.db.run(
      `INSERT INTO published (unit_id, version_no, schema_version, content_hash, min_app_version, pack_manifest_path)
       VALUES (?, ?, 1, ?, '1.0.0', 'x')`,
      [unitId, versionNo, 'c'.repeat(64)],
    );
  }

  it('tells not downloaded, up to date and update available apart', async () => {
    expect(await packStatuses(ports.db)).toEqual([]);
    await announce(UNIT_1, 1);
    await announce(UNIT_2, 1);
    expect(await packStatuses(ports.db)).toEqual([
      { unitId: UNIT_1, latestVersionNo: 1, activeVersionNo: null, availability: 'not_downloaded' },
      { unitId: UNIT_2, latestVersionNo: 1, activeVersionNo: null, availability: 'not_downloaded' },
    ]);
    await ports.db.run(
      'INSERT INTO pack_active (unit_id, version_no, activated_at) VALUES (?, 1, 1)',
      [UNIT_1],
    );
    await ports.db.run(
      'INSERT INTO pack_active (unit_id, version_no, activated_at) VALUES (?, 1, 1)',
      [UNIT_2],
    );
    await announce(UNIT_2, 2);
    const statuses = await packStatuses(ports.db);
    expect(statuses.map((s) => s.availability)).toEqual(['up_to_date', 'update_available']);
    expect(statuses[1]).toMatchObject({ latestVersionNo: 2, activeVersionNo: 1 });
  });
});
