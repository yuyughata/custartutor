import * as SecureStore from 'expo-secure-store';
import type { SecureKv } from '@custar/learner-core';

// SecureStore keys may only contain letters, digits, '.', '-' and '_'.
function safeKey(key: string): string {
  return `custar.${key.replace(/[^A-Za-z0-9._-]/g, '_')}`;
}

/** Small secrets (PIN hash, device pepper, device id) in the Keychain / Keystore. Keep values under ~2 KB. */
export const expoSecureKv: SecureKv = {
  get: (key) => SecureStore.getItemAsync(safeKey(key)),
  set: (key, value) => SecureStore.setItemAsync(safeKey(key), value),
  delete: (key) => SecureStore.deleteItemAsync(safeKey(key)),
};
