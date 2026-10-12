import type { DownloadResult, Downloader } from '../ports';
import { concatBytes } from '../utf8';
import type { MemoryFileStore } from './memory-file-store';

/** Something that can answer a URL the way a storage server would (the `FakeSyncApi` does). */
export interface UrlResolver {
  resolveUrl(url: string): { status: number; body?: Uint8Array };
}

export interface DownloadRequest {
  url: string;
  destPath: string;
  /** First byte requested (`Range: bytes=N-`), or null for a full request. */
  rangeStart: number | null;
  /** The status the fake answered with. */
  status: number;
}

interface PlannedFailure {
  afterBytes: number;
  times: number;
}

/**
 * `Downloader` over a `MemoryFileStore`, like the real one: writes `destPath + '.part'`, renames to `destPath`
 * on success, and resumes with a Range request when asked and a partial file exists.
 *
 * Content comes from `serve(url, bytes)` or from a `UrlResolver`. Test knobs:
 *  - `failAfter(url, n, times)`  the next `times` requests write `n` bytes into the .part file, then throw;
 *  - `forceStatus(url, status)`  answer that URL with a fixed status (for example 403, expired);
 *  - `supportsRange = false`     the server ignores Range and sends the whole file with 200;
 *  - `requests`                  every request, in order.
 */
export class FakeDownloader implements Downloader {
  readonly requests: DownloadRequest[] = [];
  supportsRange = true;

  private readonly served = new Map<string, Uint8Array>();
  private readonly failures = new Map<string, PlannedFailure>();
  private readonly statuses = new Map<string, number>();

  constructor(
    private readonly files: MemoryFileStore,
    private readonly resolver?: UrlResolver,
  ) {}

  serve(url: string, bytes: Uint8Array): void {
    this.served.set(url, bytes);
  }

  failAfter(url: string, afterBytes: number, times = 1): void {
    this.failures.set(url, { afterBytes, times });
  }

  forceStatus(url: string, status: number | null): void {
    if (status === null) this.statuses.delete(url);
    else this.statuses.set(url, status);
  }

  private answer(url: string): { status: number; body?: Uint8Array } {
    const forced = this.statuses.get(url);
    if (forced !== undefined) return { status: forced };
    const body = this.served.get(url);
    if (body) return { status: 200, body };
    return this.resolver?.resolveUrl(url) ?? { status: 404 };
  }

  async download(
    url: string,
    destPath: string,
    options: { resume?: boolean; signal?: AbortSignal } = {},
  ): Promise<DownloadResult> {
    const part = `${destPath}.part`;
    const partial = (await this.files.size(part)) ?? 0;
    const reply = this.answer(url);
    const record = (rangeStart: number | null, status: number): void => {
      this.requests.push({ url, destPath, rangeStart, status });
    };

    if (options.signal?.aborted) throw new Error('Download aborted');
    if (reply.status >= 400 || !reply.body) {
      record(null, reply.status);
      return { status: reply.status, bytesOnDisk: partial };
    }

    const body = reply.body;
    const resuming = options.resume === true && partial > 0 && this.supportsRange;
    if (resuming && partial > body.length) {
      record(partial, 416); // Range Not Satisfiable: the partial file is longer than the real one
      return { status: 416, bytesOnDisk: partial };
    }
    const start = resuming ? partial : 0;
    const status = resuming ? 206 : 200;
    record(resuming ? start : null, status);

    const plan = this.failures.get(url);
    if (plan && plan.times > 0) {
      plan.times -= 1;
      const chunk = body.slice(start, start + plan.afterBytes);
      const written = resuming ? concatBytes(await this.files.readBytes(part), chunk) : chunk;
      await this.files.writeBytes(part, written);
      throw new Error(`Network connection lost after ${chunk.length} bytes`);
    }

    const bytes = resuming
      ? concatBytes(await this.files.readBytes(part), body.slice(start))
      : body.slice();
    await this.files.writeBytes(part, bytes);
    await this.files.move(part, destPath);
    return { status, bytesOnDisk: bytes.length };
  }
}
