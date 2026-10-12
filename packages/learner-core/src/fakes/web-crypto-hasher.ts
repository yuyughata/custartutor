import type { FileStore, Hasher } from '../ports';
import { toHex } from '../utf8';
import { sha256Hex } from './sha256';

interface SubtleLike {
  digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>;
}

function subtle(): SubtleLike | undefined {
  return (globalThis as { crypto?: { subtle?: SubtleLike } }).crypto?.subtle;
}

/**
 * `Hasher` over `globalThis.crypto.subtle`, falling back to the pure-JS `sha256Hex` when WebCrypto is missing
 * (Hermes). `sha256FileHex` reads the file through the given store (the whole file is loaded: fine for
 * tests, demo mode and small media; the real app uses a native streaming hasher).
 */
export class WebCryptoHasher implements Hasher {
  constructor(private readonly files?: Pick<FileStore, 'readBytes'>) {}

  async sha256Hex(bytes: Uint8Array): Promise<string> {
    const api = subtle();
    if (!api) return sha256Hex(bytes);
    return toHex(new Uint8Array(await api.digest('SHA-256', bytes)));
  }

  async sha256FileHex(path: string): Promise<string> {
    if (!this.files) throw new Error('WebCryptoHasher needs a FileStore to hash files');
    return this.sha256Hex(await this.files.readBytes(path));
  }
}
