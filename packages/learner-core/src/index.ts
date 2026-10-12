/**
 * @custar/learner-core: the local-first engine behind the offline learner app.
 *
 * Pure TypeScript. Everything platform-specific (SQLite, files, downloads, hashing, secure storage, clock,
 * randomness, connectivity, the server) is injected through the ports in `ports.ts` and `api.ts`. In-memory
 * fakes for all of them are in `@custar/learner-core/fakes`; Node-only test helpers in
 * `@custar/learner-core/testing`. See README.md.
 */
export type {
  Clock,
  DownloadResult,
  Downloader,
  FileStore,
  Hasher,
  Network,
  Ports,
  Random,
  SecureKv,
  SqlDriver,
  SqlRow,
  SqlValue,
} from './ports';
export * from './errors';
export * from './wire';
export * from './api';
export * from './clock';
export * from './mastery';
export * from './session';
export * from './pin';
export * from './db';
export * from './sync';
export * from './packs';
export { concatBytes, decodeUtf8, encodeUtf8, fromHex, toHex } from './utf8';
