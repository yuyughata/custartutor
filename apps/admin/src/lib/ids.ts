/** A fresh random id, used as an idempotency key (the job API wants 8 to 100 characters). */
export function newKey(): string {
  const c = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (c?.randomUUID) return c.randomUUID();
  return `key-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
