import type { SqlDriver, SqlValue } from '../ports';
import { WireEvent } from '../wire';

/**
 * The outbox: events waiting to be pushed, oldest `device_seq` first. A row is deleted when the server
 * accepted it (or already had it). A row the server keeps rejecting is dead-lettered after
 * `MAX_ATTEMPTS`: it stays in the table (for support) but is never selected again, so it can never block
 * the rows behind it.
 */

export const MAX_ATTEMPTS = 5;

export type OutboxRow = {
  client_event_id: string;
  child_id: string;
  device_seq: number;
  payload_json: string;
  created_at: number;
  attempts: number;
  last_error: string | null;
  dead: number;
};

export interface OutboxEntry {
  row: OutboxRow;
  /** The parsed event, or null when the stored JSON is corrupt (the caller dead-letters it). */
  event: WireEvent | null;
}

export async function enqueue(tx: SqlDriver, event: WireEvent, createdAt: number): Promise<void> {
  await tx.run(
    `INSERT INTO outbox (client_event_id, child_id, device_seq, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [event.client_event_id, event.child_id, event.device_seq, JSON.stringify(event), createdAt],
  );
}

function parseEvent(json: string): WireEvent | null {
  try {
    const parsed = WireEvent.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * The next batch of live rows with `device_seq > afterSeq`, oldest first. The push loop passes the last
 * `device_seq` it handled, so a row that was rejected (and stays queued) is not selected again within the
 * same sync, which would loop forever.
 */
export async function nextBatch(
  db: SqlDriver,
  afterSeq: number,
  limit: number,
): Promise<OutboxEntry[]> {
  const rows = await db.all<OutboxRow>(
    'SELECT * FROM outbox WHERE dead = 0 AND device_seq > ? ORDER BY device_seq ASC LIMIT ?',
    [afterSeq, limit],
  );
  return rows.map((row) => ({ row, event: parseEvent(row.payload_json) }));
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

/** The server has the events: remove them from the outbox and mark the local log as synced. */
export async function markDelivered(
  tx: SqlDriver,
  clientEventIds: readonly string[],
  now: number,
): Promise<void> {
  for (let i = 0; i < clientEventIds.length; i += 100) {
    const chunk: SqlValue[] = clientEventIds.slice(i, i + 100);
    if (chunk.length === 0) continue;
    const marks = placeholders(chunk.length);
    await tx.run(`UPDATE local_event SET synced_at = ? WHERE client_event_id IN (${marks})`, [
      now,
      ...chunk,
    ]);
    await tx.run(`DELETE FROM outbox WHERE client_event_id IN (${marks})`, chunk);
  }
}

/** The server rejected the row (or gave no answer). Counts an attempt; dead-letters at `maxAttempts`. */
export async function markFailed(
  tx: SqlDriver,
  clientEventId: string,
  reason: string,
  maxAttempts = MAX_ATTEMPTS,
): Promise<{ dead: boolean; attempts: number }> {
  await tx.run(
    `UPDATE outbox SET attempts = attempts + 1, last_error = ?, dead = CASE WHEN attempts + 1 >= ? THEN 1 ELSE 0 END
     WHERE client_event_id = ?`,
    [reason.slice(0, 200), maxAttempts, clientEventId],
  );
  const row = await tx.get<{ attempts: number; dead: number }>(
    'SELECT attempts, dead FROM outbox WHERE client_event_id = ?',
    [clientEventId],
  );
  return { dead: row?.dead === 1, attempts: row?.attempts ?? 0 };
}

/** Dead-letters a row at once (corrupt JSON can never succeed). */
export async function markDead(
  tx: SqlDriver,
  clientEventId: string,
  reason: string,
): Promise<void> {
  await tx.run('UPDATE outbox SET dead = 1, last_error = ? WHERE client_event_id = ?', [
    reason.slice(0, 200),
    clientEventId,
  ]);
}

export async function outboxCounts(db: SqlDriver): Promise<{ pending: number; dead: number }> {
  const row = await db.get<{ pending: number | null; dead: number | null }>(
    'SELECT SUM(dead = 0) AS pending, SUM(dead = 1) AS dead FROM outbox',
  );
  return { pending: row?.pending ?? 0, dead: row?.dead ?? 0 };
}

export async function listDead(db: SqlDriver): Promise<OutboxRow[]> {
  return db.all<OutboxRow>('SELECT * FROM outbox WHERE dead = 1 ORDER BY device_seq');
}

/** Gives every dead-lettered row another full set of attempts (a support action). Returns how many. */
export async function reviveDead(db: SqlDriver): Promise<number> {
  const result = await db.run('UPDATE outbox SET dead = 0, attempts = 0 WHERE dead = 1');
  return result.changes;
}

/** Live (not dead) unsent events of one child, oldest first. These are the "pending local events". */
export async function listPendingEvents(
  db: SqlDriver,
  childId: string,
  unitId?: string,
): Promise<WireEvent[]> {
  const rows = await db.all<OutboxRow>(
    'SELECT * FROM outbox WHERE dead = 0 AND child_id = ? ORDER BY device_seq',
    [childId],
  );
  const events: WireEvent[] = [];
  for (const row of rows) {
    const event = parseEvent(row.payload_json);
    if (event && (unitId === undefined || event.unit_id === unitId)) events.push(event);
  }
  return events;
}

/**
 * After a full resync: drops local events and unsent rows of children this account can no longer see
 * (their access was revoked), so revoked data is purged from the device.
 */
export async function purgeUnknownChildren(tx: SqlDriver): Promise<void> {
  const known = 'SELECT id FROM child';
  await tx.run(`DELETE FROM outbox WHERE child_id NOT IN (${known})`);
  await tx.run(`DELETE FROM local_event WHERE child_id NOT IN (${known})`);
}
