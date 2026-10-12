import { createHash } from 'node:crypto';
import { parseUnit } from '@custar/content-schema';
import {
  PackManifest,
  parseGrownupContent,
  parseLearnerContent,
  splitUnitForPacks,
  verifyManifestIntegrity,
} from '@custar/content-schema';
import { colourChartProject, goldenUnit2 } from '@custar/content-schema/fixtures';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MASTERY_THRESHOLD } from '../mastery';
import { UNIT_1, CHILD_A, masteryEvent, startedEvent, uuidN } from '../test-helpers';
import { decodeUtf8, encodeUtf8 } from '../utf8';
import { PullResponse } from '../wire';
import { FakeDownloader } from './fake-downloader';
import { FakeSyncApi } from './fake-sync-api';
import { ManualClock } from './manual-clock';
import { MemoryFileStore } from './memory-file-store';
import { MemorySecureKv } from './memory-secure-kv';
import { buildPackFiles } from './pack-builder';
import { SeededRandom } from './seeded-random';
import { sha256Hex } from './sha256';
import { WebCryptoHasher } from './web-crypto-hasher';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sha256 (pure JS)', () => {
  it('matches node:crypto across padding boundaries and sizes', () => {
    for (const length of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 100_000]) {
      const data = new Uint8Array(length).map((_, i) => (i * 7 + length) & 0xff);
      expect(sha256Hex(data), `length ${length}`).toBe(
        createHash('sha256').update(data).digest('hex'),
      );
    }
    expect(sha256Hex(encodeUtf8('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('WebCryptoHasher', () => {
  it('hashes with WebCrypto and agrees with the pure fallback', async () => {
    const hasher = new WebCryptoHasher();
    const data = encodeUtf8('Yorùbá ọ̀rọ̀');
    expect(await hasher.sha256Hex(data)).toBe(sha256Hex(data));
  });

  it('falls back to pure JS when crypto.subtle is missing', async () => {
    vi.stubGlobal('crypto', undefined);
    const data = encodeUtf8('no subtle here');
    expect(await new WebCryptoHasher().sha256Hex(data)).toBe(
      createHash('sha256').update(data).digest('hex'),
    );
  });

  it('hashes files through the store, and needs one to do so', async () => {
    const files = new MemoryFileStore();
    await files.writeBytes('a/b.bin', encodeUtf8('file bytes'));
    expect(await new WebCryptoHasher(files).sha256FileHex('a/b.bin')).toBe(
      createHash('sha256').update('file bytes').digest('hex'),
    );
    await expect(new WebCryptoHasher().sha256FileHex('a/b.bin')).rejects.toThrow(/FileStore/);
  });
});

describe('utf8 fallback', () => {
  it('encodes and decodes like the platform, without TextEncoder', () => {
    const samples = [
      'plain',
      'Yorùbá: ọ̀rọ̀ àti ẹ̀kọ́',
      'Igbo: ụlọ akwụkwọ',
      'Hausa: ƙ ɗ ɓ',
      '₦500 😀 ok',
      '',
    ];
    const expected = samples.map((s) => Array.from(new TextEncoder().encode(s)));
    vi.stubGlobal('TextEncoder', undefined);
    vi.stubGlobal('TextDecoder', undefined);
    samples.forEach((sample, i) => {
      expect(Array.from(encodeUtf8(sample)), sample).toEqual(expected[i]);
      expect(decodeUtf8(Uint8Array.from(expected[i] ?? [])), sample).toBe(sample);
    });
  });
});

describe('SeededRandom', () => {
  it('is deterministic per seed and differs between seeds', () => {
    const a = new SeededRandom('seed');
    const b = new SeededRandom('seed');
    expect([a.uuid(), a.uuid()]).toEqual([b.uuid(), b.uuid()]);
    expect(new SeededRandom('other').uuid()).not.toBe(new SeededRandom('seed').uuid());
    expect(new SeededRandom(1).uuid()).not.toBe(new SeededRandom(2).uuid());
  });

  it('produces valid v4 uuids and the requested number of bytes', () => {
    const random = new SeededRandom('v4');
    for (let i = 0; i < 50; i += 1) {
      expect(random.uuid()).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
    expect(random.bytes(0)).toHaveLength(0);
    expect(random.bytes(33)).toHaveLength(33);
    expect(new Set(Array.from({ length: 500 }, () => random.uuid())).size).toBe(500);
  });
});

describe('MemoryFileStore', () => {
  let files: MemoryFileStore;
  beforeEach(() => {
    files = new MemoryFileStore({ capacityBytes: 100 });
  });

  it('reads, writes, moves, removes and sizes', async () => {
    await files.writeText('dir/a.txt', 'héllo');
    expect(await files.readText('dir/a.txt')).toBe('héllo');
    expect(await files.size('dir/a.txt')).toBe(6);
    expect(await files.size('missing')).toBeNull();
    await files.move('dir/a.txt', 'other/b.txt');
    expect(await files.exists('dir/a.txt')).toBe(false);
    expect(await files.readText('other/b.txt')).toBe('héllo');
    await files.remove('other/b.txt');
    await files.remove('other/b.txt'); // removing twice is fine
    expect(files.list()).toEqual([]);
    await expect(files.readBytes('nope')).rejects.toThrow(/ENOENT/);
    await expect(files.move('nope', 'x')).rejects.toThrow(/ENOENT/);
  });

  it('enforces its capacity and reports free space', async () => {
    await files.writeBytes('a', new Uint8Array(60));
    expect(await files.freeDiskBytes()).toBe(40);
    await expect(files.writeBytes('b', new Uint8Array(41))).rejects.toThrow(/ENOSPC/);
    await files.writeBytes('a', new Uint8Array(100)); // replacing counts the difference
    expect(await files.freeDiskBytes()).toBe(0);
  });

  it('copies on write and read so callers cannot alias storage', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    await files.writeBytes('a', bytes);
    bytes[0] = 9;
    const read = await files.readBytes('a');
    read[1] = 9;
    expect(Array.from(await files.readBytes('a'))).toEqual([1, 2, 3]);
  });

  it('refuses paths that escape the root', async () => {
    await expect(files.writeText('../x', 'y')).rejects.toThrow(/Invalid path/);
    await expect(files.exists('a/../../x')).rejects.toThrow(/Invalid path/);
  });
});

describe('MemorySecureKv and ManualClock', () => {
  it('stores, deletes and dumps', async () => {
    const kv = new MemorySecureKv();
    expect(await kv.get('k')).toBeNull();
    await kv.set('k', 'v');
    expect(kv.dump()).toEqual({ k: 'v' });
    await kv.delete('k');
    expect(await kv.get('k')).toBeNull();
  });

  it('moves only when told to', () => {
    const clock = new ManualClock(1000);
    expect(clock.now()).toBe(1000);
    clock.advance(500);
    clock.set(42);
    expect(clock.now()).toBe(42);
  });
});

describe('FakeDownloader', () => {
  it('writes a .part file, renames on success and reports bytes', async () => {
    const files = new MemoryFileStore();
    const downloader = new FakeDownloader(files);
    downloader.serve('https://x/y', encodeUtf8('hello world'));
    const result = await downloader.download('https://x/y', 'out/y.txt');
    expect(result).toEqual({ status: 200, bytesOnDisk: 11 });
    expect(files.list()).toEqual(['out/y.txt']);
    expect(await files.readText('out/y.txt')).toBe('hello world');
  });

  it('answers unknown URLs with 404 and forced statuses without touching disk', async () => {
    const files = new MemoryFileStore();
    const downloader = new FakeDownloader(files);
    expect((await downloader.download('https://nope', 'o')).status).toBe(404);
    downloader.serve('https://x', encodeUtf8('data'));
    downloader.forceStatus('https://x', 403);
    expect((await downloader.download('https://x', 'o')).status).toBe(403);
    downloader.forceStatus('https://x', null);
    expect((await downloader.download('https://x', 'o')).status).toBe(200);
    expect(downloader.requests.map((r) => r.status)).toEqual([404, 403, 200]);
  });

  it('resumes with a Range request and supports failure injection', async () => {
    const files = new MemoryFileStore();
    const downloader = new FakeDownloader(files);
    const body = new Uint8Array(100).map((_, i) => i);
    downloader.serve('https://x', body);
    downloader.failAfter('https://x', 40);
    await expect(downloader.download('https://x', 'o', { resume: true })).rejects.toThrow(
      /connection lost/,
    );
    expect(await files.size('o.part')).toBe(40);
    const result = await downloader.download('https://x', 'o', { resume: true });
    expect(result).toEqual({ status: 206, bytesOnDisk: 100 });
    expect(Array.from(await files.readBytes('o'))).toEqual(Array.from(body));
    expect(downloader.requests.map((r) => r.rangeStart)).toEqual([null, 40]);
  });

  it('ignores a partial file when not asked to resume', async () => {
    const files = new MemoryFileStore();
    const downloader = new FakeDownloader(files);
    await files.writeBytes('o.part', new Uint8Array(10));
    downloader.serve('https://x', new Uint8Array(30).fill(7));
    const result = await downloader.download('https://x', 'o');
    expect(result).toEqual({ status: 200, bytesOnDisk: 30 });
  });
});

describe('buildPackFiles', () => {
  const unit = parseUnit(goldenUnit2);
  const UNIT_ID = '11111111-1111-4111-8111-111111111111';

  it('produces a valid manifest whose hashes describe the bytes', async () => {
    const pack = await buildPackFiles(unit, {
      unitId: UNIT_ID,
      versionNo: 4,
      minAppVersion: '1.2.0',
      media: [
        { assetId: 'zari', bytes: encodeUtf8('png'), ext: 'png' },
        { assetId: 'intro', bytes: encodeUtf8('mp3'), ext: 'mp3', kind: 'audio' },
      ],
    });
    expect(PackManifest.safeParse(pack.manifest).success).toBe(true);
    expect(verifyManifestIntegrity(pack.manifest)).toEqual([]);
    expect(pack.manifest).toMatchObject({
      unit_id: UNIT_ID,
      version_no: 4,
      min_app_version: '1.2.0',
      schema_version: 1,
    });
    expect(pack.manifest.files.map((f) => f.path).sort()).toEqual([
      'audio/intro.mp3',
      'grownup.json',
      'learner.json',
      'media/zari.png',
    ]);
    for (const file of pack.manifest.files) {
      const bytes = pack.files.get(file.path);
      expect(bytes?.length, file.path).toBe(file.bytes);
      expect(
        createHash('sha256')
          .update(bytes ?? new Uint8Array())
          .digest('hex'),
        file.path,
      ).toBe(file.sha256);
    }
    expect(pack.manifest.files.find((f) => f.path === 'audio/intro.mp3')).toMatchObject({
      kind: 'audio',
      pack: 'learner',
      asset_id: 'intro',
    });
  });

  it('splits the unit: learner JSON has no manual, grown-up JSON has it, both uncompressed', async () => {
    const pack = await buildPackFiles(unit, { unitId: UNIT_ID });
    const learnerText = decodeUtf8(pack.files.get('learner.json') ?? new Uint8Array());
    const grownupText = decodeUtf8(pack.files.get('grownup.json') ?? new Uint8Array());
    expect(learnerText.startsWith('{')).toBe(true);
    expect(learnerText).not.toContain('teacher_manual');
    expect(grownupText).toContain('teacher_manual');
    const { learner, grownup } = splitUnitForPacks(unit);
    expect(JSON.parse(learnerText)).toEqual(JSON.parse(JSON.stringify(learner)));
    expect(parseGrownupContent(JSON.parse(grownupText))).toEqual(grownup);
    expect(parseLearnerContent(JSON.parse(learnerText)).kind).toBe('lesson');
  });

  it('is deterministic: same unit, same hashes', async () => {
    const a = await buildPackFiles(unit, { unitId: UNIT_ID });
    const b = await buildPackFiles(unit, { unitId: UNIT_ID });
    expect(a.manifest).toEqual(b.manifest);
  });

  it('changes content_hash when the unit changes', async () => {
    const changed = structuredClone(unit);
    changed.header.title = 'Changed';
    const a = await buildPackFiles(unit, { unitId: UNIT_ID });
    const b = await buildPackFiles(changed, { unitId: UNIT_ID });
    expect(a.manifest.content_hash).not.toBe(b.manifest.content_hash);
  });

  it('builds a project pack without a grown-up pack', async () => {
    const pack = await buildPackFiles(parseUnit(colourChartProject), { unitId: UNIT_ID });
    expect(pack.manifest.grownup_content_path).toBeNull();
    expect(pack.files.has('grownup.json')).toBe(false);
    expect(verifyManifestIntegrity(pack.manifest)).toEqual([]);
  });
});

describe('FakeSyncApi as a server', () => {
  const HOUSEHOLD = uuidN(900);
  let clock: ManualClock;
  let api: FakeSyncApi;

  beforeEach(() => {
    clock = new ManualClock();
    api = new FakeSyncApi({ now: () => clock.now() });
    api.setHousehold({ id: HOUSEHOLD, name: 'Family' });
    for (const id of [uuidN(1), uuidN(2), uuidN(3)]) {
      api.addChild({
        id,
        household_id: HOUSEHOLD,
        display_alias: `Kid ${id.slice(-1)}`,
        avatar: null,
        level_code: 'P1',
        reading_mode: 'reader',
        daily_limit_min: null,
      });
    }
  });

  it('serves a stable, ordered, paginated change feed and validates against the wire schema', async () => {
    const first = await api.pull(0, 2);
    expect(PullResponse.safeParse(first).success).toBe(true);
    expect(first).toMatchObject({ next_seq: 2, has_more: true, epoch: 1 });
    expect(first.children.map((c) => c.sync_seq)).toEqual([1, 2]);
    const second = await api.pull(first.next_seq, 2);
    expect(second).toMatchObject({ next_seq: 3, has_more: false });
    const empty = await api.pull(second.next_seq, 2);
    expect(empty).toMatchObject({ next_seq: 3, has_more: false, children: [] });
    expect(empty.household).toEqual({ id: HOUSEHOLD, name: 'Family' });
  });

  it('emits updates with a higher sync_seq and tombstones for deletes', async () => {
    api.updateChild(uuidN(1), { display_alias: 'Renamed' });
    api.deleteChild(uuidN(2));
    const page = await api.pull(3, 10);
    expect(page.children).toHaveLength(2);
    expect(page.children.find((c) => c.id === uuidN(1))).toMatchObject({
      display_alias: 'Renamed',
      sync_seq: 4,
      deleted_at: null,
    });
    expect(page.children.find((c) => c.id === uuidN(2))?.deleted_at).toBe(
      new Date(clock.now()).toISOString(),
    );
  });

  it('clamps an oversized page limit', async () => {
    const page = await api.pull(0, 100_000);
    expect(page.children).toHaveLength(3);
  });

  it('ingests idempotently with per-row results and derived progress', async () => {
    const started = startedEvent({ child_id: uuidN(1) });
    const pass = masteryEvent(0.9, true, { child_id: uuidN(1) });
    const results = await api.pushEvents([started, pass, started]);
    expect(results.map((r) => r.status)).toEqual(['accepted', 'accepted', 'duplicate']);
    expect(api.acceptedEvents()).toHaveLength(2);
    expect(api.progressRow(uuidN(1), UNIT_1)).toMatchObject({
      status: 'mastered',
      attempts: 1,
      mastery_score: 0.9,
    });
    const again = await api.pushEvents([pass]);
    expect(again[0]?.status).toBe('duplicate');
  });

  it('rejects a bad row without failing the batch', async () => {
    const good = startedEvent({ child_id: uuidN(1) });
    const stranger = startedEvent({ child_id: uuidN(77) });
    const broken = { ...startedEvent({ child_id: uuidN(1) }), device_seq: 0 };
    const lying = masteryEvent(0.2, true, { child_id: uuidN(1) });
    const results = await api.pushEvents([stranger, broken, lying, good]);
    expect(results.map((r) => [r.status, r.reason])).toEqual([
      ['rejected', 'no_access_to_child'],
      ['rejected', 'invalid_event'],
      ['rejected', 'inconsistent_mastery'],
      ['accepted', undefined],
    ]);
    expect(MASTERY_THRESHOLD).toBe(0.8);
  });

  it('refuses a batch above the cap', async () => {
    const events = Array.from({ length: 101 }, () => startedEvent({ child_id: uuidN(1) }));
    await expect(api.pushEvents(events)).rejects.toMatchObject({ code: 'server' });
  });

  it('serves packs only while their published row is live, and expires URLs on demand', async () => {
    const unit = parseUnit(goldenUnit2);
    const pack = await buildPackFiles(unit, { unitId: UNIT_1, versionNo: 1 });
    await expect(api.getPackDownload(UNIT_1, 1)).rejects.toMatchObject({ code: 'forbidden' });
    api.publishPack(pack);
    const grant = await api.getPackDownload(UNIT_1, 1);
    expect(Object.keys(grant.urls).sort()).toEqual(pack.manifest.files.map((f) => f.path).sort());
    const url = grant.urls['learner.json'] ?? '';
    expect(api.resolveUrl(url).status).toBe(200);
    api.expireSignedUrls();
    expect(api.resolveUrl(url).status).toBe(403);
    const fresh = (await api.getPackDownload(UNIT_1, 1)).urls['learner.json'] ?? '';
    expect(api.resolveUrl(fresh).status).toBe(200);
    expect(api.resolveUrl('https://elsewhere.test/x').status).toBe(404);

    const v2 = await buildPackFiles(unit, { unitId: UNIT_1, versionNo: 2 });
    api.publishPack(v2);
    const page = await api.pull(0, 100);
    expect(page.published.map((p) => [p.version_no, p.deleted_at !== null])).toEqual([
      [1, true],
      [2, false],
    ]);
    await expect(api.getPackDownload(UNIT_1, 1)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('plans failures by call number', async () => {
    api.failOnCall('pull', 2);
    await api.pull(0, 5);
    await expect(api.pull(0, 5)).rejects.toMatchObject({ code: 'offline' });
    await expect(api.pull(0, 5)).resolves.toBeDefined();
    api.failNext('pull');
    await expect(api.pull(0, 5)).rejects.toBeDefined();
  });

  it('enforces the PIN rules of the real RPCs', async () => {
    await expect(api.elevateGrownup('d', '2468')).rejects.toMatchObject({ code: 'forbidden' });
    for (const weak of ['1234', '1111', '12', 'abcd']) {
      await expect(api.setGrownupPin(weak), weak).rejects.toMatchObject({ code: 'weak_pin' });
    }
    await api.setGrownupPin('2468'); // the first PIN needs no elevation
    await expect(api.setGrownupPin('1357')).rejects.toMatchObject({ code: 'elevation_required' });
    const elevation = await api.elevateGrownup('device-1', '2468');
    expect(Date.parse(elevation.expires_at)).toBe(clock.now() + 600_000);
    await api.setGrownupPin('1357');
    clock.advance(600_001);
    await expect(api.setGrownupPin('2468')).rejects.toMatchObject({ code: 'elevation_required' });
  });
});

describe('seeded ids', () => {
  it('uses well-formed ids in test helpers', () => {
    expect(startedEvent().child_id).toBe(CHILD_A);
  });
});
