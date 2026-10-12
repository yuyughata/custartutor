import { Platform } from 'react-native';
import * as SQLite from 'expo-sqlite';
import type { SqlDriver, SqlRow, SqlValue } from '@custar/learner-core';

/** The statement methods shared by a database and an exclusive-transaction object in expo-sqlite. */
interface Runner {
  execAsync(source: string): Promise<void>;
  runAsync(source: string, params: SQLite.SQLiteBindValue[]): Promise<{ changes: number }>;
  getAllAsync<T>(source: string, params: SQLite.SQLiteBindValue[]): Promise<T[]>;
  getFirstAsync<T>(source: string, params: SQLite.SQLiteBindValue[]): Promise<T | null>;
}

function toBind(params: readonly SqlValue[] | undefined): SQLite.SQLiteBindValue[] {
  return params ? [...params] : [];
}

function wrap(
  runner: Runner,
  begin?: <T>(fn: (tx: SqlDriver) => Promise<T>) => Promise<T>,
): SqlDriver {
  const driver: SqlDriver = {
    exec: (sql) => runner.execAsync(sql),
    run: async (sql, params) => {
      const result = await runner.runAsync(sql, toBind(params));
      return { changes: result.changes };
    },
    all: async <T extends SqlRow = SqlRow>(sql: string, params?: readonly SqlValue[]) =>
      runner.getAllAsync<T>(sql, toBind(params)),
    get: async <T extends SqlRow = SqlRow>(sql: string, params?: readonly SqlValue[]) =>
      (await runner.getFirstAsync<T>(sql, toBind(params))) ?? undefined,
    // Inside a transaction a nested call simply continues in the same transaction.
    transaction: begin ?? (async (fn) => fn(driver)),
  };
  return driver;
}

/**
 * Opens (or creates) the learner database. WAL is on for crash safety and concurrent reads.
 * `transaction` is exclusive on native (`withExclusiveTransactionAsync`: no other statement can
 * interleave), and falls back to a plain transaction on web, where the exclusive form is unsupported.
 */
export async function openExpoSqlite(name = 'custar-learner.db'): Promise<SqlDriver> {
  const db = await SQLite.openDatabaseAsync(name);
  await db.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

  const transaction = async <T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T> => {
    let result: T | undefined;
    let done = false;
    if (Platform.OS === 'web') {
      await db.withTransactionAsync(async () => {
        result = await fn(wrap(db));
        done = true;
      });
    } else {
      await db.withExclusiveTransactionAsync(async (txn) => {
        result = await fn(wrap(txn as unknown as Runner));
        done = true;
      });
    }
    if (!done) throw new Error('transaction did not complete');
    return result as T;
  };

  return wrap(db as unknown as Runner, transaction);
}
