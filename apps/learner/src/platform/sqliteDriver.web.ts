import initSqlJs, { type BindParams, type Database } from 'sql.js';
import type { SqlDriver, SqlRow, SqlValue } from '@custar/learner-core';

/**
 * Web-only SQLite (sql.js, in memory) so the app's demo mode can run in a browser. The native app uses
 * expo-sqlite (`sqliteDriver.ts`). Offline learning is native-only (docs/plan.md section 6), so nothing here
 * persists: reloading the page starts the demo fresh.
 */
export async function openExpoSqlite(_name?: string): Promise<SqlDriver> {
  const SQL = await initSqlJs({ locateFile: () => '/sql-wasm.wasm' });
  const db = new SQL.Database();
  return createDriver(db);
}

function bind(params: readonly SqlValue[] | undefined): BindParams {
  return (params ? [...params] : []) as BindParams;
}

function queryAll<T extends SqlRow>(db: Database, sql: string, params?: readonly SqlValue[]): T[] {
  const statement = db.prepare(sql);
  try {
    statement.bind(bind(params));
    const rows: T[] = [];
    while (statement.step()) rows.push(statement.getAsObject() as T);
    return rows;
  } finally {
    statement.free();
  }
}

function createDriver(db: Database): SqlDriver {
  let queue: Promise<unknown> = Promise.resolve();

  const driver: SqlDriver = {
    async exec(sql) {
      db.exec(sql);
    },
    async run(sql, params) {
      const statement = db.prepare(sql);
      try {
        statement.run(bind(params));
      } finally {
        statement.free();
      }
      return { changes: db.getRowsModified() };
    },
    async all<T extends SqlRow = SqlRow>(sql: string, params?: readonly SqlValue[]) {
      return queryAll<T>(db, sql, params);
    },
    async get<T extends SqlRow = SqlRow>(
      sql: string,
      params?: readonly SqlValue[],
    ): Promise<T | undefined> {
      const rows = queryAll<T>(db, sql, params);
      return rows[0];
    },
    // Exclusive: one transaction at a time. Nested calls inside a transaction reuse it.
    transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T> {
      const run = async (): Promise<T> => {
        db.exec('BEGIN IMMEDIATE');
        try {
          const result = await fn({ ...driver, transaction: (inner) => inner(driver) });
          db.exec('COMMIT');
          return result;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      };
      const next = queue.then(run, run);
      queue = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
  };
  return driver;
}
