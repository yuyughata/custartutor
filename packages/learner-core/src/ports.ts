/**
 * Ports: everything platform-specific the learner engine needs, injected by the app (or by fakes in
 * tests). The core never imports React Native, Expo or Supabase. See docs/adr/0003-sync-protocol.md and
 * docs/adr/0004-lesson-packs.md.
 */

export type SqlValue = string | number | null | Uint8Array;
export type SqlRow = Record<string, SqlValue>;

/**
 * A SQLite connection. In the app it wraps `expo-sqlite` (WAL, exclusive transactions); in tests it wraps
 * `node:sqlite`. `transaction` MUST be exclusive: no other statement on the connection may interleave
 * with the callback (expo-sqlite's `withExclusiveTransactionAsync`).
 */
export interface SqlDriver {
  /** Runs one or more statements separated by semicolons. No parameters. */
  exec(sql: string): Promise<void>;
  run(sql: string, params?: readonly SqlValue[]): Promise<{ changes: number }>;
  all<T extends SqlRow = SqlRow>(sql: string, params?: readonly SqlValue[]): Promise<T[]>;
  get<T extends SqlRow = SqlRow>(sql: string, params?: readonly SqlValue[]): Promise<T | undefined>;
  /** Runs `fn` inside an exclusive transaction; rolls back if `fn` throws. `tx` must be used inside `fn`. */
  transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T>;
}

/** App-private file storage (expo-file-system document directory in the app, a temp dir in tests). */
export interface FileStore {
  exists(path: string): Promise<boolean>;
  readText(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
  /** Must be atomic: write to a temporary name, then rename, so a crash never leaves a half file. */
  writeText(path: string, text: string): Promise<void>;
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;
  /** Creates parent directories as needed. */
  move(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** Size in bytes, or null when the file does not exist. */
  size(path: string): Promise<number | null>;
  /** Free space on the volume that holds the store. */
  freeDiskBytes(): Promise<number>;
}

export interface DownloadResult {
  /** HTTP status. 200 or 206 are successes. 403 or 401 usually means the signed URL expired. */
  status: number;
  /** Bytes now on disk at the destination (the `.part` file is renamed by the implementation on success). */
  bytesOnDisk: number;
}

/** Resumable file download to disk. The core re-requests a signed URL and retries when `status` is 401/403. */
export interface Downloader {
  /**
   * Downloads `url` to `destPath`. When `resume` is true and a partial file exists, continues from its size
   * with a `Range` request. Implementations write to `destPath + '.part'` and move to `destPath` on success.
   */
  download(
    url: string,
    destPath: string,
    options?: { resume?: boolean; signal?: AbortSignal },
  ): Promise<DownloadResult>;
}

export interface Hasher {
  sha256Hex(bytes: Uint8Array): Promise<string>;
  /** Hash a file without loading it all into memory when the platform allows it. */
  sha256FileHex(path: string): Promise<string>;
}

/** Small secrets (PIN hash, device pepper, device id). Backed by the Keystore / Keychain via SecureStore. */
export interface SecureKv {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface Clock {
  /** Milliseconds since the Unix epoch. Device time: untrusted, see `TrustedClock`. */
  now(): number;
}

export interface Random {
  /** RFC 4122 v4 UUID. */
  uuid(): string;
  bytes(length: number): Uint8Array;
}

export interface Ports {
  db: SqlDriver;
  files: FileStore;
  downloader: Downloader;
  hasher: Hasher;
  secure: SecureKv;
  clock: Clock;
  random: Random;
}
