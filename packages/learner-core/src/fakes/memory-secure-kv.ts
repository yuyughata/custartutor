import type { SecureKv } from '../ports';

/** In-memory `SecureKv`. `dump()` lets tests assert what was (not) stored, for example that no PIN is. */
export class MemorySecureKv implements SecureKv {
  private readonly data = new Map<string, string>();

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.data.get(key) ?? null);
  }

  set(key: string, value: string): Promise<void> {
    this.data.set(key, value);
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.data.delete(key);
    return Promise.resolve();
  }

  dump(): Record<string, string> {
    return Object.fromEntries(this.data);
  }
}
