/**
 * Platform-neutral in-memory implementations of the ports, plus a fake server. NO Node built-ins are imported
 * anywhere under `src/fakes`, so this entry works in Metro/Hermes and in the browser (the app's demo mode) as
 * well as in tests. Node-only helpers (the `node:sqlite` driver) live in `@custar/learner-core/testing`.
 */
export { correctResponse, wrongResponse } from './answers';
export { DEMO_IDS, DEMO_PIN, createDemoServer } from './demo-server';
export type { DemoServer } from './demo-server';
export { FakeDownloader } from './fake-downloader';
export type { DownloadRequest, UrlResolver } from './fake-downloader';
export { FakeSyncApi } from './fake-sync-api';
export type { FakeApiMethod, FakeSyncApiOptions } from './fake-sync-api';
export { ManualClock } from './manual-clock';
export { MemoryFileStore } from './memory-file-store';
export type { MemoryFileStoreOptions } from './memory-file-store';
export { MemorySecureKv } from './memory-secure-kv';
export { FakeNetwork } from './network';
export { GROWNUP_CONTENT_PATH, LEARNER_CONTENT_PATH, buildPackFiles } from './pack-builder';
export type { BuildPackOptions, BuiltPack, PackMedia } from './pack-builder';
export { SeededRandom } from './seeded-random';
export { sha256, sha256Hex } from './sha256';
export { WebCryptoHasher } from './web-crypto-hasher';
