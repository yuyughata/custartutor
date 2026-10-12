import { DownloadError, IntegrityError } from '../errors';
import type { PackFileRow } from '../db/packs';
import { setPackFileState } from '../db/packs';
import type { Ports } from '../ports';
import type { UrlBook } from './url-book';

export interface FetchContext {
  ports: Pick<Ports, 'db' | 'files' | 'downloader' | 'hasher'>;
  urls: UrlBook;
  signal?: AbortSignal;
}

async function discard(ctx: FetchContext, dest: string): Promise<void> {
  await ctx.ports.files.remove(dest);
  await ctx.ports.files.remove(`${dest}.part`);
}

/**
 * Downloads one file to `dest` and proves it is the right one.
 *
 *  - resumes a partial file (`.part`) with a Range request when one exists;
 *  - on 401/403 asks the `UrlBook` for fresh signed URLs ONCE and retries;
 *  - on a size or SHA-256 mismatch (or a 416 for a stale partial) deletes the file and downloads it again
 *    from scratch ONCE, then fails with `IntegrityError`;
 *  - a transport failure leaves the `.part` file, records the bytes so far in `pack_file`
 *    (state `partial`) and throws `DownloadError`, so the next `downloadUnit` call resumes.
 * Returns the number of bytes that crossed the network (the file size minus what was already there).
 */
export async function fetchFile(
  ctx: FetchContext,
  row: PackFileRow,
  dest: string,
): Promise<number> {
  const { db, files, downloader, hasher } = ctx.ports;
  let resigned = false;
  let restarted = false;
  let fresh = false; // true once we have decided to ignore any partial file
  const startBytes = (await files.size(`${dest}.part`)) ?? 0;

  for (;;) {
    const partial = fresh ? 0 : ((await files.size(`${dest}.part`)) ?? 0);
    if (fresh) await files.remove(`${dest}.part`);
    await setPackFileState(
      db,
      row.unit_id,
      row.version_no,
      row.path,
      partial > 0 ? 'partial' : 'pending',
      partial,
    );

    const generation = ctx.urls.current();
    const url = ctx.urls.urlFor(row.path);
    if (!url) throw new DownloadError(row.path, `The server sent no URL for ${row.path}`);

    let status: number;
    try {
      const options: { resume: boolean; signal?: AbortSignal } = { resume: partial > 0 };
      if (ctx.signal) options.signal = ctx.signal;
      ({ status } = await downloader.download(url, dest, options));
    } catch (error) {
      const got = (await files.size(`${dest}.part`)) ?? 0;
      await setPackFileState(
        db,
        row.unit_id,
        row.version_no,
        row.path,
        got > 0 ? 'partial' : 'pending',
        got,
      );
      throw new DownloadError(row.path, `Download of ${row.path} was interrupted`, undefined, {
        cause: error,
      });
    }

    if (status === 401 || status === 403) {
      if (resigned) {
        throw new DownloadError(
          row.path,
          'The download link was rejected even after renewing it',
          status,
        );
      }
      resigned = true;
      await ctx.urls.refresh(generation);
      continue;
    }
    if (status === 416 && !restarted) {
      restarted = true;
      fresh = true;
      continue;
    }
    if (status !== 200 && status !== 206) {
      throw new DownloadError(row.path, `Unexpected HTTP ${status} for ${row.path}`, status);
    }

    const size = await files.size(dest);
    const actual =
      size === row.bytes ? await hasher.sha256FileHex(dest) : `size:${size ?? 'missing'}`;
    if (size === row.bytes && actual === row.sha256) {
      await setPackFileState(db, row.unit_id, row.version_no, row.path, 'verified', row.bytes);
      return Math.max(0, row.bytes - (fresh ? 0 : startBytes));
    }

    await discard(ctx, dest);
    if (restarted) {
      throw new IntegrityError(
        row.path,
        `${row.path} does not match its checksum after a second download`,
        row.sha256,
        actual,
      );
    }
    restarted = true;
    fresh = true;
  }
}
