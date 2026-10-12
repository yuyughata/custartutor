import type { Random, SqlDriver } from '../ports';

/** Keys of the `meta` table. Values are strings; numbers are stored in decimal. */
export const META = {
  /** Opaque id of this installation, sent with every event and with PIN elevation. */
  deviceId: 'device_id',
  /** Last `device_seq` handed out. Strictly increasing for the life of this database. */
  deviceSeq: 'device_seq',
  /** `sync_seq` cursor: everything up to here has been applied. */
  lastSyncSeq: 'last_sync_seq',
  /** Household membership epoch of the data currently stored. */
  membershipEpoch: 'membership_epoch',
  /** Server time (epoch ms) of the last successful pull: anchors the offline grace window. */
  lastVerifiedAt: 'last_verified_at',
  /** Highest time (epoch ms) this device has trusted; the floor for `TrustedClock.now()`. */
  maxSeenTime: 'max_seen_time',
  /** Last measured `server - device` offset in ms (diagnostics). */
  serverOffsetMs: 'server_offset_ms',
} as const;

export type MetaKey = (typeof META)[keyof typeof META];

export async function getMeta(db: SqlDriver, key: MetaKey): Promise<string | null> {
  const row = await db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [key]);
  return row?.value ?? null;
}

export async function setMeta(db: SqlDriver, key: MetaKey, value: string): Promise<void> {
  await db.run(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value],
  );
}

export async function deleteMeta(db: SqlDriver, key: MetaKey): Promise<void> {
  await db.run('DELETE FROM meta WHERE key = ?', [key]);
}

export async function getMetaNumber(db: SqlDriver, key: MetaKey): Promise<number | null> {
  const value = await getMeta(db, key);
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function setMetaNumber(db: SqlDriver, key: MetaKey, value: number): Promise<void> {
  await setMeta(db, key, String(value));
}

/** The installation id; created on first use. Call inside a transaction when atomicity matters. */
export async function getOrCreateDeviceId(db: SqlDriver, random: Random): Promise<string> {
  const existing = await getMeta(db, META.deviceId);
  if (existing !== null) return existing;
  const created = random.uuid();
  // INSERT OR IGNORE then re-read: two racing creators converge on one id.
  await db.run('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)', [META.deviceId, created]);
  return (await getMeta(db, META.deviceId)) ?? created;
}

/** Hands out the next per-device sequence number. Must run inside the transaction that stores the event. */
export async function nextDeviceSeq(tx: SqlDriver): Promise<number> {
  const next = ((await getMetaNumber(tx, META.deviceSeq)) ?? 0) + 1;
  await setMetaNumber(tx, META.deviceSeq, next);
  return next;
}

export async function getLastSyncSeq(db: SqlDriver): Promise<number> {
  return (await getMetaNumber(db, META.lastSyncSeq)) ?? 0;
}
