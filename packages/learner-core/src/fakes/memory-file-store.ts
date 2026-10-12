import type { FileStore } from '../ports';
import { decodeUtf8, encodeUtf8 } from '../utf8';

export interface MemoryFileStoreOptions {
  /** Size of the pretend volume. Writes beyond it throw `ENOSPC`. Default 64 GiB. */
  capacityBytes?: number;
}

/** In-memory `FileStore` with a configurable disk size. Paths are relative; `..` segments are refused. */
export class MemoryFileStore implements FileStore {
  private readonly data = new Map<string, Uint8Array>();
  private capacity: number;

  constructor(options: MemoryFileStoreOptions = {}) {
    this.capacity = options.capacityBytes ?? 64 * 1024 ** 3;
  }

  private key(path: string): string {
    const parts = path.split('/').filter((part) => part !== '' && part !== '.');
    if (parts.length === 0 || parts.includes('..')) throw new Error(`Invalid path: ${path}`);
    return parts.join('/');
  }

  private put(path: string, bytes: Uint8Array): void {
    const key = this.key(path);
    const replaced = this.data.get(key)?.length ?? 0;
    if (this.usedBytes() - replaced + bytes.length > this.capacity) {
      throw new Error(`ENOSPC: no space left on device while writing ${key}`);
    }
    this.data.set(key, bytes.slice());
  }

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.data.has(this.key(path)));
  }

  async readText(path: string): Promise<string> {
    return decodeUtf8(await this.readBytes(path));
  }

  readBytes(path: string): Promise<Uint8Array> {
    const bytes = this.data.get(this.key(path));
    if (!bytes) return Promise.reject(new Error(`ENOENT: ${path}`));
    return Promise.resolve(bytes.slice());
  }

  writeText(path: string, text: string): Promise<void> {
    this.put(path, encodeUtf8(text));
    return Promise.resolve();
  }

  writeBytes(path: string, bytes: Uint8Array): Promise<void> {
    this.put(path, bytes);
    return Promise.resolve();
  }

  move(from: string, to: string): Promise<void> {
    const bytes = this.data.get(this.key(from));
    if (!bytes) return Promise.reject(new Error(`ENOENT: ${from}`));
    this.data.delete(this.key(from));
    this.data.set(this.key(to), bytes);
    return Promise.resolve();
  }

  remove(path: string): Promise<void> {
    this.data.delete(this.key(path));
    return Promise.resolve();
  }

  size(path: string): Promise<number | null> {
    return Promise.resolve(this.data.get(this.key(path))?.length ?? null);
  }

  freeDiskBytes(): Promise<number> {
    return Promise.resolve(Math.max(0, this.capacity - this.usedBytes()));
  }

  // ---- test helpers ----------------------------------------------------------------------------

  usedBytes(): number {
    let total = 0;
    for (const bytes of this.data.values()) total += bytes.length;
    return total;
  }

  setCapacity(bytes: number): void {
    this.capacity = bytes;
  }

  /** Paths currently stored, sorted; `prefix` filters. */
  list(prefix = ''): string[] {
    return [...this.data.keys()].filter((key) => key.startsWith(prefix)).sort();
  }
}
