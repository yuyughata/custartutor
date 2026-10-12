import { describe, expect, it } from 'vitest';
import { DatabaseTooNewError } from '../errors';
import { NodeSqliteDriver } from '../testing/node-sqlite-driver';
import { migrate } from './migrate';
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from './migrations';
import type { Migration } from './migrations';

async function tables(db: NodeSqliteDriver): Promise<string[]> {
  const rows = await db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  return rows.map((row) => row.name);
}

async function version(db: NodeSqliteDriver): Promise<number> {
  return (await db.get<{ user_version: number }>('PRAGMA user_version'))?.user_version ?? -1;
}

describe('migrate', () => {
  it('has contiguous versions starting at 1', () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 1));
    expect(LATEST_SCHEMA_VERSION).toBe(MIGRATIONS.length);
  });

  it('creates every table from version 0', async () => {
    const db = new NodeSqliteDriver();
    expect(await version(db)).toBe(0);
    expect(await migrate(db)).toBe(LATEST_SCHEMA_VERSION);
    expect(await version(db)).toBe(LATEST_SCHEMA_VERSION);
    expect(await tables(db)).toEqual(
      [
        'child',
        'household',
        'local_event',
        'meta',
        'outbox',
        'pack_active',
        'pack_file',
        'published',
        'subject',
        'tutor_lite_state',
        'unit',
        'unit_progress',
      ].sort(),
    );
  });

  it('is idempotent and keeps data', async () => {
    const db = new NodeSqliteDriver();
    await migrate(db);
    await db.run("INSERT INTO meta (key, value) VALUES ('device_id', 'abc')");
    expect(await migrate(db)).toBe(LATEST_SCHEMA_VERSION);
    expect(await migrate(db)).toBe(LATEST_SCHEMA_VERSION);
    expect((await db.all('SELECT * FROM meta')).length).toBe(1);
  });

  it('upgrades from an intermediate version and keeps its data', async () => {
    const db = new NodeSqliteDriver();
    expect(await migrate(db, MIGRATIONS.slice(0, 1))).toBe(1);
    expect(await tables(db)).not.toContain('outbox');
    await db.run("INSERT INTO household (id, name) VALUES ('h1', 'Okafor family')");
    await db.run("INSERT INTO meta (key, value) VALUES ('last_sync_seq', '42')");

    expect(await migrate(db, MIGRATIONS.slice(0, 2))).toBe(2);
    expect(await tables(db)).toContain('pack_file');
    expect(await tables(db)).not.toContain('outbox');

    expect(await migrate(db)).toBe(LATEST_SCHEMA_VERSION);
    expect(await tables(db)).toContain('outbox');
    expect(await tables(db)).toContain('tutor_lite_state');
    expect(await db.get('SELECT name FROM household WHERE id = ?', ['h1'])).toEqual({
      name: 'Okafor family',
    });
    expect(
      (await db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'last_sync_seq'"))
        ?.value,
    ).toBe('42');
  });

  it('refuses a database written by a newer app', async () => {
    const db = new NodeSqliteDriver();
    await db.exec('PRAGMA user_version = 99');
    await expect(migrate(db)).rejects.toBeInstanceOf(DatabaseTooNewError);
    expect(await version(db)).toBe(99);
  });

  it('applies each migration once when called concurrently', async () => {
    const db = new NodeSqliteDriver();
    const results = await Promise.all([migrate(db), migrate(db), migrate(db)]);
    expect(results).toEqual([LATEST_SCHEMA_VERSION, LATEST_SCHEMA_VERSION, LATEST_SCHEMA_VERSION]);
  });

  it('rolls a failing migration back completely, version included', async () => {
    const db = new NodeSqliteDriver();
    const broken: Migration[] = [
      { version: 1, name: 'ok', sql: 'CREATE TABLE a (id INTEGER);' },
      {
        version: 2,
        name: 'broken',
        sql: 'CREATE TABLE b (id INTEGER); CREATE TABLE a (id INTEGER);',
      },
    ];
    await expect(migrate(db, broken)).rejects.toThrow();
    expect(await version(db)).toBe(1);
    expect(await tables(db)).toEqual(['a']);
  });

  it('rejects a list with a gap', async () => {
    const db = new NodeSqliteDriver();
    await expect(
      migrate(db, [{ version: 2, name: 'gap', sql: 'CREATE TABLE a (id INTEGER);' }]),
    ).rejects.toThrow(/expected 1/);
  });
});
