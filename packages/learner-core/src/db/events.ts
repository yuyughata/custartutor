import type { Clock, Random, SqlDriver } from '../ports';
import { WireEvent } from '../wire';
import { getOrCreateDeviceId, nextDeviceSeq } from './meta';
import { enqueue } from './outbox';

/** What a caller supplies; the device id, sequence number and event id are assigned here. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type NewEvent = DistributiveOmit<WireEvent, 'client_event_id' | 'device_id' | 'device_seq'>;

/**
 * Records events: in ONE transaction it takes the next `device_seq` for each, writes the rows to
 * `local_event` (the device's own log) and to `outbox` (the push queue). If anything fails nothing is
 * written and no sequence number is consumed. Returns the stored events in order.
 */
export async function appendEvents(
  ports: { db: SqlDriver; random: Random; clock: Clock },
  inputs: readonly NewEvent[],
): Promise<WireEvent[]> {
  const { db, random, clock } = ports;
  return db.transaction(async (tx) => {
    const deviceId = await getOrCreateDeviceId(tx, random);
    const stored: WireEvent[] = [];
    for (const input of inputs) {
      const deviceSeq = await nextDeviceSeq(tx);
      const event = WireEvent.parse({
        ...input,
        client_event_id: random.uuid(),
        device_id: deviceId,
        device_seq: deviceSeq,
      });
      await tx.run(
        `INSERT INTO local_event (client_event_id, child_id, unit_id, device_seq, event_type, occurred_at, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          event.client_event_id,
          event.child_id,
          event.unit_id,
          event.device_seq,
          event.event_type,
          event.occurred_at,
          JSON.stringify(event.payload),
        ],
      );
      await enqueue(tx, event, clock.now());
      stored.push(event);
    }
    return stored;
  });
}

/** One event; see `appendEvents`. */
export async function appendEvent(
  ports: { db: SqlDriver; random: Random; clock: Clock },
  input: NewEvent,
): Promise<WireEvent> {
  const [event] = await appendEvents(ports, [input]);
  if (!event) throw new Error('appendEvents returned no event');
  return event;
}

export type LocalEventRecord = {
  client_event_id: string;
  child_id: string;
  unit_id: string;
  device_seq: number;
  event_type: string;
  occurred_at: string;
  payload_json: string;
  synced_at: number | null;
};

/** The device's own event log (synced or not), oldest first. */
export async function listLocalEvents(
  db: SqlDriver,
  filter: { childId: string; unitId?: string },
): Promise<LocalEventRecord[]> {
  if (filter.unitId === undefined) {
    return db.all<LocalEventRecord>(
      'SELECT * FROM local_event WHERE child_id = ? ORDER BY device_seq',
      [filter.childId],
    );
  }
  return db.all<LocalEventRecord>(
    'SELECT * FROM local_event WHERE child_id = ? AND unit_id = ? ORDER BY device_seq',
    [filter.childId, filter.unitId],
  );
}

/** Deletes events the server accepted more than `olderThanMs` ago. The server's progress rows cover them. */
export async function pruneSyncedEvents(db: SqlDriver, olderThanMs: number): Promise<number> {
  const result = await db.run(
    'DELETE FROM local_event WHERE synced_at IS NOT NULL AND synced_at < ?',
    [olderThanMs],
  );
  return result.changes;
}
