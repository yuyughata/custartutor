import { appCanReadPack, filesForPack, verifyManifestIntegrity } from '@custar/content-schema';
import type { PackFile, PackManifest } from '@custar/content-schema';
import type { SyncApi } from '../api';
import { SyncApiError } from '../api';
import {
  activatePack,
  findVerifiedBlob,
  getActivePack,
  listPackFiles,
  markPackFilesVerified,
  registerPackFiles,
} from '../db/packs';
import type { PackFileRow } from '../db/packs';
import { deletePackVersionRows } from '../db/packs';
import { getPublished } from '../db/reference';
import { DiskSpaceError, IntegrityError, NetworkPolicyError, PackTooNewError } from '../errors';
import type { Network, Ports } from '../ports';
import { PackDownload } from '../wire';
import { fetchFile } from './fetch-file';
import { loadActiveLesson, loadActiveUnit, loadGrownupContent } from './loader';
import type { LoadedLesson, LoadedUnit } from './loader';
import { localPathFor, manifestPath } from './paths';
import { discardAbandoned, releaseSuperseded, removeUnit } from './release';
import type { ReleaseReport } from './release';
import { storageUsage } from './usage';
import type { StorageUsage } from './usage';
import { UrlBook } from './url-book';

/** Free space that must remain after a download (the phone still needs room to run). */
export const DEFAULT_DISK_MARGIN_BYTES = 50 * 1024 * 1024;

export interface DownloadManagerOptions {
  ports: Pick<Ports, 'db' | 'files' | 'downloader' | 'hasher' | 'clock'>;
  /** Only `getPackDownload` is used. */
  api: Pick<SyncApi, 'getPackDownload'>;
  network: Network;
  /** This build's version, compared with each pack's `min_app_version`. */
  appVersion: string;
  /** Default 50 MB. */
  diskMarginBytes?: number;
}

export interface DownloadOptions {
  /** Refuse unless the connection is unmetered. */
  wifiOnly?: boolean;
  /** Also fetch the grown-up pack (teacher's manual). Default true. */
  includeGrownup?: boolean;
  onProgress?: (progress: DownloadProgress) => void;
  signal?: AbortSignal;
}

export interface DownloadProgress {
  /** Bytes fetched so far in this call, and the total this call has to fetch. */
  bytesDone: number;
  bytesTotal: number;
  path: string;
}

export interface DownloadReport {
  unitId: string;
  versionNo: number;
  /** Bytes that crossed the network in this call. */
  bytesDownloaded: number;
  filesDownloaded: number;
  /** Files already on the device (verified earlier, or a shared blob). */
  filesReused: number;
  /** The version that was playing before this one took over, now waiting for `releaseSuperseded`. */
  supersededVersionNo: number | null;
  /** How many times the server was asked to sign URLs (more than 1 means an expiry was handled). */
  urlGrants: number;
}

interface PlannedFile {
  file: PackFile;
  dest: string;
  /** Rows of this pack that share the blob (media listed under several paths). */
  rows: PackFileRow[];
}

/**
 * Downloads, verifies, activates and loads lesson packs (ADR 0004). The device keeps a pack per
 * (unit, version): JSON under `packs/<unit>/<version>/`, media under `blobs/<sha256>`.
 */
export class DownloadManager {
  private readonly ports: DownloadManagerOptions['ports'];
  private readonly api: DownloadManagerOptions['api'];
  private readonly network: Network;
  private readonly appVersion: string;
  private readonly margin: number;
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly inflight = new Map<string, Promise<DownloadReport>>();

  constructor(options: DownloadManagerOptions) {
    this.ports = options.ports;
    this.api = options.api;
    this.network = options.network;
    this.appVersion = options.appVersion;
    this.margin = options.diskMarginBytes ?? DEFAULT_DISK_MARGIN_BYTES;
  }

  /**
   * Makes `versionNo` of a unit playable offline.
   *
   * Order of events (nothing is written before the checks pass):
   *  1. network policy (`NetworkPolicyError`), signed URLs from the server, manifest sanity
   *     (`IntegrityError`), app version (`PackTooNewError`);
   *  2. free space against the bytes still to fetch plus the margin (`DiskSpaceError`);
   *  3. every missing file is downloaded (resuming partial files) and verified by SHA-256;
   *  4. the manifest is stored and `pack_active` flips to the new version in ONE transaction. The old version
   *     stays on disk, recorded as `superseded_version_no`, until `releaseSuperseded`.
   * Safe to call again after any failure: verified files are kept and partial ones resume.
   */
  downloadUnit(
    unitId: string,
    versionNo: number,
    options: DownloadOptions = {},
  ): Promise<DownloadReport> {
    // The same request while one is running shares it; other work on the same unit waits its turn.
    const key = `${unitId}:${versionNo}`;
    const running = this.inflight.get(key);
    if (running) return running;
    const run = this.exclusive(unitId, () => this.download(unitId, versionNo, options)).finally(
      () => {
        this.inflight.delete(key);
      },
    );
    this.inflight.set(key, run);
    return run;
  }

  /** Runs `fn` after everything queued before it for the same unit has finished. */
  private exclusive<T>(unitId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(unitId) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(unitId, tail);
    void tail.then(() => {
      if (this.chains.get(unitId) === tail) this.chains.delete(unitId);
    });
    return next;
  }

  private async download(
    unitId: string,
    versionNo: number,
    options: DownloadOptions,
  ): Promise<DownloadReport> {
    const { db, files, clock } = this.ports;
    if (!(await this.network.isOnline())) throw new NetworkPolicyError('offline');
    if (options.wifiOnly && !(await this.network.isUnmetered()))
      throw new NetworkPolicyError('metered');

    const grantRaw = await this.api.getPackDownload(unitId, versionNo);
    const parsedGrant = PackDownload.safeParse(grantRaw);
    if (!parsedGrant.success)
      throw new SyncApiError('bad_response', 'Malformed pack download response');
    const grant = parsedGrant.data;
    const { manifest } = grant;
    this.checkManifest(manifest, unitId, versionNo);
    if (!appCanReadPack(this.appVersion, manifest.min_app_version)) {
      throw new PackTooNewError(manifest.min_app_version, this.appVersion);
    }
    const published = await getPublished(db, unitId, versionNo);
    if (published && published.content_hash !== manifest.content_hash) {
      throw new IntegrityError(
        'manifest',
        'The lesson does not match what the server announced',
        published.content_hash,
        manifest.content_hash,
      );
    }

    const wanted = filesForPack(manifest, options.includeGrownup === false ? 'learner' : 'all');
    for (const file of wanted) {
      if (!grant.urls[file.path])
        throw new IntegrityError(file.path, `No download link for ${file.path}`);
    }

    await discardAbandoned(this.ports, unitId, [versionNo]);
    await this.dropStaleRows(unitId, versionNo, wanted);

    const byPath = new Map(wanted.map((file) => [file.path, file]));
    const existing = new Map((await listPackFiles(db, unitId, versionNo)).map((r) => [r.path, r]));
    const { plan, reused, bytesNeeded } = await this.plan(unitId, versionNo, wanted, existing);

    if (plan.length > 0) {
      const free = await files.freeDiskBytes();
      if (free < bytesNeeded + this.margin)
        throw new DiskSpaceError(bytesNeeded + this.margin, free);
    }

    await db.transaction(async (tx) => {
      await registerPackFiles(tx, unitId, versionNo, wanted);
      await markPackFilesVerified(
        tx,
        unitId,
        versionNo,
        reused.map((path) => ({
          path,
          bytes: existing.get(path)?.bytes ?? byPath.get(path)?.bytes ?? 0,
        })),
      );
    });

    const urls = new UrlBook(this.api, unitId, versionNo, manifest.content_hash, grant);
    let done = 0;
    let fetched = 0;
    const rowByPath = new Map((await listPackFiles(db, unitId, versionNo)).map((r) => [r.path, r]));
    for (const item of plan) {
      const row = rowByPath.get(item.file.path);
      if (!row) throw new Error(`Bookkeeping lost ${item.file.path}`);
      const network = await fetchFile(
        { ports: this.ports, urls, ...(options.signal ? { signal: options.signal } : {}) },
        row,
        item.dest,
      );
      done += network;
      fetched += 1;
      // every other path that points at the same blob is verified too
      const twins = item.rows.filter((other) => other.path !== row.path);
      if (twins.length > 0) {
        await db.transaction((tx) => markPackFilesVerified(tx, unitId, versionNo, twins));
      }
      options.onProgress?.({ bytesDone: done, bytesTotal: bytesNeeded, path: item.file.path });
    }

    await this.assertVerified(unitId, versionNo, wanted);
    await files.writeText(manifestPath(unitId, versionNo), JSON.stringify(manifest));

    const current = await getActivePack(db, unitId);
    if (current && current.version_no !== versionNo && current.superseded_version_no !== null) {
      await releaseSuperseded(this.ports, unitId); // an older swap that was never released
    }
    const { superseded } = await db.transaction((tx) =>
      activatePack(tx, unitId, versionNo, clock.now()),
    );

    return {
      unitId,
      versionNo,
      bytesDownloaded: done,
      filesDownloaded: fetched,
      filesReused: wanted.length - plan.reduce((n, p) => n + p.rows.length, 0),
      supersededVersionNo: superseded,
      urlGrants: urls.grants,
    };
  }

  private checkManifest(manifest: PackManifest, unitId: string, versionNo: number): void {
    if (manifest.unit_id !== unitId || manifest.version_no !== versionNo) {
      throw new IntegrityError('manifest', 'The server sent a manifest for a different lesson');
    }
    const issues = verifyManifestIntegrity(manifest);
    if (issues.length > 0)
      throw new IntegrityError('manifest', `Invalid lesson manifest: ${issues.join('; ')}`);
  }

  /** A row whose hash or size differs from the manifest is stale (the file, if any, is useless): forget it. */
  private async dropStaleRows(
    unitId: string,
    versionNo: number,
    wanted: readonly PackFile[],
  ): Promise<void> {
    const byPath = new Map(wanted.map((f) => [f.path, f]));
    const stale = (await listPackFiles(this.ports.db, unitId, versionNo)).filter((row) => {
      const file = byPath.get(row.path);
      return file !== undefined && (file.sha256 !== row.sha256 || file.bytes !== row.bytes);
    });
    if (stale.length === 0) return;
    await this.ports.db.transaction(async (tx) => {
      await deletePackVersionRows(tx, unitId, versionNo);
    });
    for (const row of stale) {
      const dest = localPathFor(unitId, versionNo, row);
      await this.ports.files.remove(dest);
      await this.ports.files.remove(`${dest}.part`);
    }
  }

  private async plan(
    unitId: string,
    versionNo: number,
    wanted: readonly PackFile[],
    existing: Map<string, PackFileRow>,
  ): Promise<{ plan: PlannedFile[]; reused: string[]; bytesNeeded: number }> {
    const { db, files } = this.ports;
    const plan: PlannedFile[] = [];
    const reused: string[] = [];
    const bySha = new Map<string, PlannedFile>();
    let bytesNeeded = 0;

    for (const file of wanted) {
      const dest = localPathFor(unitId, versionNo, file);
      const row = existing.get(file.path);
      const onDisk = await files.size(dest);
      const asRow: PackFileRow = row ?? {
        unit_id: unitId,
        version_no: versionNo,
        path: file.path,
        sha256: file.sha256,
        bytes: file.bytes,
        kind: file.kind,
        pack: file.pack,
        asset_id: file.asset_id ?? null,
        state: 'pending',
        downloaded_bytes: 0,
      };

      // already fetched and checked
      if (row?.state === 'verified' && onDisk === file.bytes) {
        reused.push(file.path);
        continue;
      }
      // a content-addressed blob that another unit or version already holds
      if (
        file.kind !== 'content' &&
        onDisk === file.bytes &&
        (await findVerifiedBlob(db, file.sha256))
      ) {
        reused.push(file.path);
        continue;
      }
      // finished on disk but the app died before it was marked verified: prove it instead of fetching again
      if (onDisk === file.bytes && (await this.ports.hasher.sha256FileHex(dest)) === file.sha256) {
        reused.push(file.path);
        continue;
      }
      // the same blob listed twice in this pack: fetch once
      const twin = file.kind !== 'content' ? bySha.get(file.sha256) : undefined;
      if (twin) {
        twin.rows.push(asRow);
        continue;
      }

      const partial = Math.min((await files.size(`${dest}.part`)) ?? 0, file.bytes);
      bytesNeeded += file.bytes - partial;
      const item: PlannedFile = { file, dest, rows: [asRow] };
      plan.push(item);
      if (file.kind !== 'content') bySha.set(file.sha256, item);
    }
    return { plan, reused, bytesNeeded };
  }

  private async assertVerified(
    unitId: string,
    versionNo: number,
    wanted: readonly PackFile[],
  ): Promise<void> {
    const rows = await listPackFiles(this.ports.db, unitId, versionNo);
    const state = new Map(rows.map((r) => [r.path, r.state]));
    for (const file of wanted) {
      if (state.get(file.path) !== 'verified') {
        throw new IntegrityError(
          file.path,
          `${file.path} was not verified, refusing to activate the lesson`,
        );
      }
    }
  }

  // ---- reading ---------------------------------------------------------------------------------

  /** The active pack's learner content, parsed leniently. See `loadActiveUnit` in `loader.ts`. */
  loadActiveUnit(unitId: string): Promise<LoadedUnit> {
    return loadActiveUnit(this.ports, this.appVersion, unitId);
  }

  loadActiveLesson(unitId: string): Promise<LoadedLesson> {
    return loadActiveLesson(this.ports, this.appVersion, unitId);
  }

  loadGrownupContent(unitId: string) {
    return loadGrownupContent(this.ports, unitId);
  }

  // ---- housekeeping ----------------------------------------------------------------------------

  /** Deletes the version replaced by the last activation. Call when the child's session ends. */
  releaseSuperseded(unitId: string): Promise<ReleaseReport> {
    return this.exclusive(unitId, () => releaseSuperseded(this.ports, unitId));
  }

  /** Deletes every downloaded version of a unit. */
  removeUnit(unitId: string): Promise<ReleaseReport> {
    return this.exclusive(unitId, () => removeUnit(this.ports, unitId));
  }

  storageUsage(): Promise<StorageUsage> {
    return storageUsage(this.ports);
  }
}
