import { TrustedClock } from '../clock';
import { migrate } from '../db/migrate';
import { FakeDownloader } from '../fakes/fake-downloader';
import { FakeSyncApi } from '../fakes/fake-sync-api';
import { ManualClock } from '../fakes/manual-clock';
import { MemoryFileStore } from '../fakes/memory-file-store';
import { MemorySecureKv } from '../fakes/memory-secure-kv';
import { FakeNetwork } from '../fakes/network';
import { SeededRandom } from '../fakes/seeded-random';
import { WebCryptoHasher } from '../fakes/web-crypto-hasher';
import type { Network, Ports } from '../ports';
import { NodeSqliteDriver } from './node-sqlite-driver';

/** `Ports` plus the concrete fakes (typed as themselves, so tests can drive and inspect them). */
export interface TestPorts extends Ports {
  db: NodeSqliteDriver;
  files: MemoryFileStore;
  downloader: FakeDownloader;
  hasher: WebCryptoHasher;
  secure: MemorySecureKv;
  clock: ManualClock;
  random: SeededRandom;
  network: FakeNetwork & Network;
  /** The in-memory server. `downloader` resolves its signed URLs. */
  api: FakeSyncApi;
}

export interface CreateTestPortsOptions {
  /** Seed of the deterministic `Random`. Default `'test'`. */
  seed?: number | string;
  /** Start time of the manual clock (epoch ms). */
  startMs?: number;
  /** Size of the pretend disk. */
  capacityBytes?: number;
  /** Run the migrations (default true). */
  migrate?: boolean;
}

/**
 * Composes Node's SQLite driver with the platform-neutral fakes: a ready `Ports` for engine tests. The fake
 * server shares the manual clock, and the downloader is wired to serve the server's signed pack URLs.
 */
export async function createTestPorts(options: CreateTestPortsOptions = {}): Promise<TestPorts> {
  const clock = new ManualClock(options.startMs);
  const files = new MemoryFileStore(
    options.capacityBytes !== undefined ? { capacityBytes: options.capacityBytes } : {},
  );
  const api = new FakeSyncApi({ now: () => clock.now() });
  const db = new NodeSqliteDriver();
  if (options.migrate !== false) await migrate(db);
  return {
    db,
    files,
    downloader: new FakeDownloader(files, api),
    hasher: new WebCryptoHasher(files),
    secure: new MemorySecureKv(),
    clock,
    random: new SeededRandom(options.seed ?? 'test'),
    network: new FakeNetwork(),
    api,
  };
}

/** A `TrustedClock` over the test ports' manual clock. */
export function createTrustedClock(ports: Pick<TestPorts, 'db' | 'clock'>): Promise<TrustedClock> {
  return TrustedClock.create(ports.db, ports.clock);
}
