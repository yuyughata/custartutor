import type { SqlDriver } from '../ports';
import type { ChildRow, HouseholdRow, PublishedRow, SubjectRow, UnitRow } from '../wire';

/**
 * Repositories for the server-synced reference tables: household, child, subject, unit, published.
 * Upserts are guarded by `sync_seq` so replaying an older page can never overwrite newer data.
 * Everything takes a `SqlDriver`, so callers pass `tx` inside a transaction.
 */

// ---- household ---------------------------------------------------------------------------------

export type LocalHousehold = { id: string; name: string };

export async function getHousehold(db: SqlDriver): Promise<LocalHousehold | null> {
  return (await db.get<LocalHousehold>('SELECT id, name FROM household LIMIT 1')) ?? null;
}

/** The learner has exactly one household. A different id replaces the old one; `null` clears it. */
export async function setHousehold(tx: SqlDriver, household: HouseholdRow | null): Promise<void> {
  if (household === null) {
    await tx.run('DELETE FROM household');
    return;
  }
  await tx.run('DELETE FROM household WHERE id <> ?', [household.id]);
  await tx.run(
    'INSERT INTO household (id, name) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name',
    [household.id, household.name],
  );
}

// ---- child -------------------------------------------------------------------------------------

export type LocalChild = {
  id: string;
  household_id: string;
  display_alias: string;
  avatar: string | null;
  level_code: string;
  reading_mode: string;
  daily_limit_min: number | null;
  sync_seq: number;
};

export async function upsertChild(tx: SqlDriver, row: ChildRow): Promise<void> {
  await tx.run(
    `INSERT INTO child (id, household_id, display_alias, avatar, level_code, reading_mode, daily_limit_min, sync_seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       household_id = excluded.household_id, display_alias = excluded.display_alias,
       avatar = excluded.avatar, level_code = excluded.level_code, reading_mode = excluded.reading_mode,
       daily_limit_min = excluded.daily_limit_min, sync_seq = excluded.sync_seq
     WHERE excluded.sync_seq >= child.sync_seq`,
    [
      row.id,
      row.household_id,
      row.display_alias,
      row.avatar,
      row.level_code,
      row.reading_mode,
      row.daily_limit_min,
      row.sync_seq,
    ],
  );
}

export async function listChildren(db: SqlDriver): Promise<LocalChild[]> {
  return db.all<LocalChild>('SELECT * FROM child ORDER BY display_alias, id');
}

export async function getChild(db: SqlDriver, id: string): Promise<LocalChild | null> {
  return (await db.get<LocalChild>('SELECT * FROM child WHERE id = ?', [id])) ?? null;
}

/**
 * Removes a child and everything this device holds about them: server-derived progress, local events and
 * unsent outbox rows (the server would reject them anyway, and a deleted child's data must not linger).
 */
export async function deleteChildCascade(tx: SqlDriver, childId: string): Promise<void> {
  await tx.run('DELETE FROM unit_progress WHERE child_id = ?', [childId]);
  await tx.run('DELETE FROM local_event WHERE child_id = ?', [childId]);
  await tx.run('DELETE FROM outbox WHERE child_id = ?', [childId]);
  await tx.run('DELETE FROM child WHERE id = ?', [childId]);
}

// ---- subject -----------------------------------------------------------------------------------

export type LocalSubject = {
  id: string;
  slug: string;
  name: string;
  kind: string;
  curriculum_source: string;
  icon: string | null;
  colour: string | null;
  sort: number;
  sync_seq: number;
};

export async function upsertSubject(tx: SqlDriver, row: SubjectRow): Promise<void> {
  await tx.run(
    `INSERT INTO subject (id, slug, name, kind, curriculum_source, icon, colour, sort, sync_seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       slug = excluded.slug, name = excluded.name, kind = excluded.kind,
       curriculum_source = excluded.curriculum_source, icon = excluded.icon, colour = excluded.colour,
       sort = excluded.sort, sync_seq = excluded.sync_seq
     WHERE excluded.sync_seq >= subject.sync_seq`,
    [
      row.id,
      row.slug,
      row.name,
      row.kind,
      row.curriculum_source,
      row.icon,
      row.colour,
      row.sort,
      row.sync_seq,
    ],
  );
}

export async function listSubjects(db: SqlDriver): Promise<LocalSubject[]> {
  return db.all<LocalSubject>('SELECT * FROM subject ORDER BY sort, name, id');
}

export async function deleteSubject(tx: SqlDriver, id: string): Promise<void> {
  await tx.run('DELETE FROM subject WHERE id = ?', [id]);
}

// ---- unit --------------------------------------------------------------------------------------

export type LocalUnit = {
  id: string;
  subject_id: string;
  chapter_number: number;
  chapter_title: string;
  unit_no: number;
  week_no: number | null;
  kind: string;
  title: string;
  objective: string | null;
  stage: string;
  level_code: string;
  term: number;
  sync_seq: number;
};

export async function upsertUnit(tx: SqlDriver, row: UnitRow): Promise<void> {
  await tx.run(
    `INSERT INTO unit (id, subject_id, chapter_number, chapter_title, unit_no, week_no, kind, title,
                       objective, stage, level_code, term, sync_seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       subject_id = excluded.subject_id, chapter_number = excluded.chapter_number,
       chapter_title = excluded.chapter_title, unit_no = excluded.unit_no, week_no = excluded.week_no,
       kind = excluded.kind, title = excluded.title, objective = excluded.objective,
       stage = excluded.stage, level_code = excluded.level_code, term = excluded.term,
       sync_seq = excluded.sync_seq
     WHERE excluded.sync_seq >= unit.sync_seq`,
    [
      row.id,
      row.subject_id,
      row.chapter_number,
      row.chapter_title,
      row.unit_no,
      row.week_no,
      row.kind,
      row.title,
      row.objective,
      row.stage,
      row.level_code,
      row.term,
      row.sync_seq,
    ],
  );
}

export async function deleteUnit(tx: SqlDriver, id: string): Promise<void> {
  await tx.run('DELETE FROM unit WHERE id = ?', [id]);
}

export async function getUnit(db: SqlDriver, id: string): Promise<LocalUnit | null> {
  return (await db.get<LocalUnit>('SELECT * FROM unit WHERE id = ?', [id])) ?? null;
}

/** Units in teaching order: term, chapter, unit. Filter by subject and/or level. */
export async function listUnits(
  db: SqlDriver,
  filter: { subjectId?: string; levelCode?: string } = {},
): Promise<LocalUnit[]> {
  const where: string[] = [];
  const params: string[] = [];
  if (filter.subjectId !== undefined) {
    where.push('subject_id = ?');
    params.push(filter.subjectId);
  }
  if (filter.levelCode !== undefined) {
    where.push('level_code = ?');
    params.push(filter.levelCode);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  return db.all<LocalUnit>(
    `SELECT * FROM unit ${clause} ORDER BY subject_id, level_code, term, chapter_number, unit_no, id`,
    params,
  );
}

// ---- published ---------------------------------------------------------------------------------

export type LocalPublished = {
  unit_id: string;
  version_no: number;
  schema_version: number;
  content_hash: string;
  min_app_version: string;
  pack_manifest_path: string;
  sync_seq: number;
};

export async function upsertPublished(tx: SqlDriver, row: PublishedRow): Promise<void> {
  await tx.run(
    `INSERT INTO published (unit_id, version_no, schema_version, content_hash, min_app_version,
                            pack_manifest_path, sync_seq)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(unit_id, version_no) DO UPDATE SET
       schema_version = excluded.schema_version, content_hash = excluded.content_hash,
       min_app_version = excluded.min_app_version, pack_manifest_path = excluded.pack_manifest_path,
       sync_seq = excluded.sync_seq
     WHERE excluded.sync_seq >= published.sync_seq`,
    [
      row.unit_id,
      row.version_no,
      row.schema_version,
      row.content_hash,
      row.min_app_version,
      row.pack_manifest_path,
      row.sync_seq,
    ],
  );
}

export async function deletePublished(
  tx: SqlDriver,
  unitId: string,
  versionNo: number,
): Promise<void> {
  await tx.run('DELETE FROM published WHERE unit_id = ? AND version_no = ?', [unitId, versionNo]);
}

/** The newest published version of a unit that the server still offers, or null. */
export async function latestPublished(
  db: SqlDriver,
  unitId: string,
): Promise<LocalPublished | null> {
  return (
    (await db.get<LocalPublished>(
      'SELECT * FROM published WHERE unit_id = ? ORDER BY version_no DESC LIMIT 1',
      [unitId],
    )) ?? null
  );
}

export async function getPublished(
  db: SqlDriver,
  unitId: string,
  versionNo: number,
): Promise<LocalPublished | null> {
  return (
    (await db.get<LocalPublished>('SELECT * FROM published WHERE unit_id = ? AND version_no = ?', [
      unitId,
      versionNo,
    ])) ?? null
  );
}

// ---- wipe --------------------------------------------------------------------------------------

/**
 * Epoch change: drops everything the server told us about households and curriculum. Keeps the outbox,
 * local events (purged separately once the new picture is known), pack files and `meta`.
 */
export async function wipeServerData(tx: SqlDriver): Promise<void> {
  for (const table of ['household', 'child', 'subject', 'unit', 'published', 'unit_progress']) {
    await tx.run(`DELETE FROM ${table}`);
  }
}

/**
 * Sign-out / account switch: removes every trace of the account's data from the device, including unsent
 * events, the local event log, progress, the sync cursor and the epoch. Keeps the device id and sequence
 * (they identify the installation), the clock state and downloaded packs (public curriculum content).
 */
export async function purgeAccountData(db: SqlDriver): Promise<void> {
  await db.transaction(async (tx) => {
    await wipeServerData(tx);
    await tx.run('DELETE FROM outbox');
    await tx.run('DELETE FROM local_event');
    await tx.run(
      "DELETE FROM meta WHERE key IN ('last_sync_seq', 'membership_epoch', 'last_verified_at', 'server_offset_ms')",
    );
  });
}
