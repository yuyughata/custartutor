import type { SyncApi } from '../api';
import { IntegrityError } from '../errors';
import type { PackDownload } from '../wire';

/**
 * Holds the signed URLs of one download and refreshes them when the server says they expired (401/403).
 * Several files may hit an expiry at about the same time: a `generation` counter lets the first one fetch
 * fresh URLs and the others simply pick them up.
 */
export class UrlBook {
  private urls: Record<string, string>;
  private generation = 0;
  private refreshing: Promise<void> | null = null;
  /** How many times the server was asked for URLs (1 = the initial grant only). */
  grants = 1;

  constructor(
    private readonly api: Pick<SyncApi, 'getPackDownload'>,
    private readonly unitId: string,
    private readonly versionNo: number,
    private readonly contentHash: string,
    initial: PackDownload,
  ) {
    this.urls = initial.urls;
  }

  current(): number {
    return this.generation;
  }

  urlFor(path: string): string | undefined {
    return this.urls[path];
  }

  /** Fetches fresh URLs unless another caller already did since `staleGeneration`. */
  async refresh(staleGeneration: number): Promise<void> {
    if (this.generation !== staleGeneration) return;
    this.refreshing ??= this.fetchFresh().finally(() => {
      this.refreshing = null;
    });
    await this.refreshing;
  }

  private async fetchFresh(): Promise<void> {
    const grant = await this.api.getPackDownload(this.unitId, this.versionNo);
    this.grants += 1;
    if (grant.manifest.content_hash !== this.contentHash) {
      throw new IntegrityError(
        'manifest',
        'The lesson changed on the server while it was downloading. Try again.',
        this.contentHash,
        grant.manifest.content_hash,
      );
    }
    this.urls = grant.urls;
    this.generation += 1;
  }
}
