import { AppState, Platform } from 'react-native';
import aesjs from 'aes-js';
import * as Crypto from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * The Supabase auth session is bigger than SecureStore's ~2 KB value limit, so it is encrypted with AES-256
 * (key kept in the Keychain / Keystore) and the ciphertext is stored in an app-private file. This is the
 * same pattern Supabase documents for Expo, using expo-file-system instead of AsyncStorage.
 */
class EncryptedSessionStorage {
  private readonly dir = new Directory(Paths.document, 'custar', 'auth');

  private file(key: string): File {
    return new File(this.dir, `${key.replace(/[^A-Za-z0-9._-]/g, '_')}.enc`);
  }

  private async loadKey(key: string): Promise<Uint8Array | null> {
    const hex = await SecureStore.getItemAsync(
      `custar.authkey.${key.replace(/[^A-Za-z0-9._-]/g, '_')}`,
    );
    return hex ? aesjs.utils.hex.toBytes(hex) : null;
  }

  async getItem(key: string): Promise<string | null> {
    const file = this.file(key);
    if (!file.exists) return null;
    const aesKey = await this.loadKey(key);
    if (!aesKey) return null;
    const cipher = new aesjs.ModeOfOperation.ctr(aesKey, new aesjs.Counter(1));
    return aesjs.utils.utf8.fromBytes(cipher.decrypt(aesjs.utils.hex.toBytes(await file.text())));
  }

  async setItem(key: string, value: string): Promise<void> {
    const aesKey = Crypto.getRandomBytes(32);
    await SecureStore.setItemAsync(
      `custar.authkey.${key.replace(/[^A-Za-z0-9._-]/g, '_')}`,
      aesjs.utils.hex.fromBytes(aesKey),
    );
    const cipher = new aesjs.ModeOfOperation.ctr(aesKey, new aesjs.Counter(1));
    const encrypted = aesjs.utils.hex.fromBytes(cipher.encrypt(aesjs.utils.utf8.toBytes(value)));
    if (!this.dir.exists) this.dir.create({ intermediates: true });
    const file = this.file(key);
    if (!file.exists) file.create({ overwrite: true });
    file.write(encrypted);
  }

  async removeItem(key: string): Promise<void> {
    const file = this.file(key);
    if (file.exists) file.delete();
    await SecureStore.deleteItemAsync(`custar.authkey.${key.replace(/[^A-Za-z0-9._-]/g, '_')}`);
  }
}

export interface SupabaseConfig {
  url: string;
  publishableKey: string;
}

/** Reads the project URL and publishable key from EXPO_PUBLIC_ variables. Returns null when absent (demo mode). */
export function readSupabaseConfig(): SupabaseConfig | null {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.EXPO_PUBLIC_SUPABASE_KEY;
  return url && publishableKey ? { url, publishableKey } : null;
}

export function createSupabase(config: SupabaseConfig): SupabaseClient {
  const client = createClient(config.url, config.publishableKey, {
    auth: {
      ...(Platform.OS === 'web' ? {} : { storage: new EncryptedSessionStorage() }),
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  });
  // Refresh tokens only while the app is in the foreground (Supabase guidance for React Native).
  if (Platform.OS !== 'web') {
    AppState.addEventListener('change', (state) => {
      if (state === 'active') void client.auth.startAutoRefresh();
      else void client.auth.stopAutoRefresh();
    });
    void client.auth.startAutoRefresh();
  }
  return client;
}
