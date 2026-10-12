import type { SqlDriver } from '../ports';

/**
 * Tutor Lite state (M3): where a child is in the offline, scripted tutor of one section, so a restart resumes
 * exactly. The package stays free of tutor-core, so the state is an opaque JSON string here; the app parses it.
 *
 * Privacy: this table holds the engine's state only (node id, counters, cursors, finished). Nothing the child
 * typed is ever stored; that is the app's job to keep true, and `tutor-lite.test.ts` pins it down.
 */

export type TutorLiteStateRow = {
  child_id: string;
  unit_id: string;
  section_id: string;
  state_json: string;
  /** Local epoch milliseconds. */
  updated_at: number;
};

export interface TutorLiteKey {
  childId: string;
  unitId: string;
  sectionId: string;
}

/** Inserts or replaces the state of one (child, unit, section). */
export async function saveTutorLiteState(
  db: SqlDriver,
  key: TutorLiteKey,
  stateJson: string,
  nowMs: number,
): Promise<void> {
  await db.run(
    `INSERT INTO tutor_lite_state (child_id, unit_id, section_id, state_json, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(child_id, unit_id, section_id) DO UPDATE SET
       state_json = excluded.state_json, updated_at = excluded.updated_at`,
    [key.childId, key.unitId, key.sectionId, stateJson, nowMs],
  );
}

export async function getTutorLiteState(
  db: SqlDriver,
  key: TutorLiteKey,
): Promise<TutorLiteStateRow | null> {
  return (
    (await db.get<TutorLiteStateRow>(
      'SELECT * FROM tutor_lite_state WHERE child_id = ? AND unit_id = ? AND section_id = ?',
      [key.childId, key.unitId, key.sectionId],
    )) ?? null
  );
}

/** Every saved section of a unit for a child, most recently used first. */
export async function listTutorLiteStates(
  db: SqlDriver,
  childId: string,
  unitId: string,
): Promise<TutorLiteStateRow[]> {
  return db.all<TutorLiteStateRow>(
    'SELECT * FROM tutor_lite_state WHERE child_id = ? AND unit_id = ? ORDER BY updated_at DESC, section_id',
    [childId, unitId],
  );
}

/** Forgets one section's place (start the script again). */
export async function deleteTutorLiteState(db: SqlDriver, key: TutorLiteKey): Promise<void> {
  await db.run(
    'DELETE FROM tutor_lite_state WHERE child_id = ? AND unit_id = ? AND section_id = ?',
    [key.childId, key.unitId, key.sectionId],
  );
}

/** Everything saved for a child. Used when the child is removed from this device. */
export async function deleteTutorLiteStateForChild(tx: SqlDriver, childId: string): Promise<void> {
  await tx.run('DELETE FROM tutor_lite_state WHERE child_id = ?', [childId]);
}

/** After a full resync: drops the state of children this account can no longer see. */
export async function purgeTutorLiteStateOfUnknownChildren(tx: SqlDriver): Promise<void> {
  await tx.run('DELETE FROM tutor_lite_state WHERE child_id NOT IN (SELECT id FROM child)');
}

/** Sign-out / account switch. */
export async function deleteAllTutorLiteState(tx: SqlDriver): Promise<void> {
  await tx.run('DELETE FROM tutor_lite_state');
}
