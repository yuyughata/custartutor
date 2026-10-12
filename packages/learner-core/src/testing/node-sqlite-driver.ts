import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import type { SqlDriver, SqlRow, SqlValue } from '../ports';

/**
 * A `SqlDriver` over `node:sqlite` for tests (Node only; the app supplies an expo-sqlite adapter).
 *
 * Exclusivity: every statement on the outer driver and every `transaction` goes through one promise mutex, so
 * nothing interleaves with an open transaction. Inside the callback only the `tx` argument may be used; calling
 * the outer driver from inside the callback would deadlock on the mutex, so it throws a clear error instead.
 * Nested `tx.transaction(...)` calls become SAVEPOINTs.
 */

class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const next = this.tail.then(() => fn());
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

function bind(params: readonly SqlValue[] | undefined): SQLInputValue[] {
  return (params ?? []).map((value) => value);
}

function plain<T extends SqlRow>(row: unknown): T {
  return { ...(row as object) } as T;
}

/** Statement execution on one connection; shared by the outer driver and the transaction handle. */
class Executor {
  constructor(private readonly db: DatabaseSync) {}

  exec(sql: string): void {
    this.db.exec(sql);
  }

  run(sql: string, params?: readonly SqlValue[]): { changes: number } {
    const result = this.db.prepare(sql).run(...bind(params));
    return { changes: Number(result.changes) };
  }

  all<T extends SqlRow>(sql: string, params?: readonly SqlValue[]): T[] {
    return this.db
      .prepare(sql)
      .all(...bind(params))
      .map((row) => plain<T>(row));
  }

  get<T extends SqlRow>(sql: string, params?: readonly SqlValue[]): T | undefined {
    const row = this.db.prepare(sql).get(...bind(params));
    return row === undefined ? undefined : plain<T>(row);
  }
}

class TransactionHandle implements SqlDriver {
  private savepoints = 0;

  constructor(private readonly exec_: Executor) {}

  exec(sql: string): Promise<void> {
    this.exec_.exec(sql);
    return Promise.resolve();
  }

  run(sql: string, params?: readonly SqlValue[]): Promise<{ changes: number }> {
    return Promise.resolve(this.exec_.run(sql, params));
  }

  all<T extends SqlRow = SqlRow>(sql: string, params?: readonly SqlValue[]): Promise<T[]> {
    return Promise.resolve(this.exec_.all<T>(sql, params));
  }

  get<T extends SqlRow = SqlRow>(
    sql: string,
    params?: readonly SqlValue[],
  ): Promise<T | undefined> {
    return Promise.resolve(this.exec_.get<T>(sql, params));
  }

  async transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T> {
    this.savepoints += 1;
    const name = `sp_${this.savepoints}`;
    this.exec_.exec(`SAVEPOINT ${name}`);
    try {
      const result = await fn(this);
      this.exec_.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      this.exec_.exec(`ROLLBACK TO ${name}`);
      this.exec_.exec(`RELEASE ${name}`);
      throw error;
    }
  }
}

export class NodeSqliteDriver implements SqlDriver {
  private readonly db: DatabaseSync;
  private readonly executor: Executor;
  private readonly mutex = new Mutex();
  private readonly insideTransaction = new AsyncLocalStorage<true>();

  /** `':memory:'` (default) or a file path. */
  constructor(location = ':memory:') {
    this.db = new DatabaseSync(location);
    this.executor = new Executor(this.db);
  }

  private guard(): void {
    if (this.insideTransaction.getStore()) {
      throw new Error(
        'The outer SqlDriver was used inside a transaction callback; use the `tx` argument instead.',
      );
    }
  }

  exec(sql: string): Promise<void> {
    this.guard();
    return this.mutex.run(() => this.executor.exec(sql));
  }

  run(sql: string, params?: readonly SqlValue[]): Promise<{ changes: number }> {
    this.guard();
    return this.mutex.run(() => this.executor.run(sql, params));
  }

  all<T extends SqlRow = SqlRow>(sql: string, params?: readonly SqlValue[]): Promise<T[]> {
    this.guard();
    return this.mutex.run(() => this.executor.all<T>(sql, params));
  }

  get<T extends SqlRow = SqlRow>(
    sql: string,
    params?: readonly SqlValue[],
  ): Promise<T | undefined> {
    this.guard();
    return this.mutex.run(() => this.executor.get<T>(sql, params));
  }

  transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T> {
    this.guard();
    return this.mutex.run(async () => {
      this.executor.exec('BEGIN IMMEDIATE');
      try {
        const result = await this.insideTransaction.run(true, () =>
          fn(new TransactionHandle(this.executor)),
        );
        this.executor.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          this.executor.exec('ROLLBACK');
        } catch {
          // the transaction already ended; keep the original error
        }
        throw error;
      }
    });
  }

  close(): void {
    this.db.close();
  }
}
