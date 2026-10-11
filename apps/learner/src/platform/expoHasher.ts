import * as Crypto from 'expo-crypto';
import type { FileStore, Hasher } from '@custar/learner-core';

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 through expo-crypto. File hashing reads the file into memory, fine for pack-sized files. */
export function createExpoHasher(files: FileStore): Hasher {
  return {
    sha256Hex: async (bytes) =>
      toHex(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes)),
    sha256FileHex: async (path) =>
      toHex(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, await files.readBytes(path))),
  };
}

export const expoRandom = {
  uuid: (): string => Crypto.randomUUID(),
  bytes: (length: number): Uint8Array => Crypto.getRandomBytes(length),
};
