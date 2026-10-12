import { DatabaseTooNewError } from '../errors';
import type { SqlDriver } from '../ports';
import { MIGRATIONS } from './migrations';
import type { Migration } from './migrations';

async function userVersion(db: SqlDriver): Promise<number> {
  const row = await db.get<{ user_version: number }>('PRAGMA user_version');
  return row?.user_version ?? 0;
}

function assertContiguous(migrations: readonly Migration[]): void {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(
        `Migration ${migration.name} has version ${migration.version}; expected ${index + 1}.`,
      );
    }
  });
}

/**
 * Brings the local database up to the latest schema. Safe to call on every launch and from several
 * places at once: each migration runs in its own exclusive transaction and re-checks `user_version`
 * inside it, so it is applied exactly once. Returns the resulting version. Throws
 * `DatabaseTooNewError` when the file was written by a newer build (never downgrade).
 */
export async function migrate(
  db: SqlDriver,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<number> {
  assertContiguous(migrations);
  const latest = migrations.length;
  const current = await userVersion(db);
  if (current > latest) throw new DatabaseTooNewError(current, latest);

  for (const migration of migrations) {
    if (migration.version <= current) continue;
    await db.transaction(async (tx) => {
      if ((await userVersion(tx)) >= migration.version) return; // another caller got here first
      await tx.exec(migration.sql);
      await tx.exec(`PRAGMA user_version = ${migration.version}`);
    });
  }
  return userVersion(db);
}
