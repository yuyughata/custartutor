import { describe, expect, it } from 'vitest';
import { NodeSqliteDriver } from './node-sqlite-driver';

async function fresh(): Promise<NodeSqliteDriver> {
  const db = new NodeSqliteDriver();
  await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, data BLOB, n REAL)');
  return db;
}

describe('NodeSqliteDriver', () => {
  it('binds params, including Uint8Array and null, and reads them back as plain rows', async () => {
    const db = await fresh();
    const bytes = new Uint8Array([1, 2, 3, 255]);
    await db.run('INSERT INTO t (id, name, data, n) VALUES (?, ?, ?, ?)', [1, 'a', bytes, 1.5]);
    await db.run('INSERT INTO t (id, name, data, n) VALUES (?, ?, ?, ?)', [2, null, null, null]);
    const row = await db.get<{ id: number; name: string; data: Uint8Array; n: number }>(
      'SELECT * FROM t WHERE id = ?',
      [1],
    );
    expect(row?.name).toBe('a');
    expect(Array.from(row?.data ?? [])).toEqual([1, 2, 3, 255]);
    expect(row?.n).toBe(1.5);
    expect(await db.get('SELECT * FROM t WHERE id = 99')).toBeUndefined();
    const all = await db.all('SELECT id, name FROM t ORDER BY id');
    expect(all).toEqual([
      { id: 1, name: 'a' },
      { id: 2, name: null },
    ]);
    expect((await db.run('UPDATE t SET name = ?', ['z'])).changes).toBe(2);
  });

  it('commits on success and rolls back when the callback throws', async () => {
    const db = await fresh();
    await db.transaction(async (tx) => {
      await tx.run('INSERT INTO t (id, name) VALUES (1, ?)', ['kept']);
    });
    await expect(
      db.transaction(async (tx) => {
        await tx.run('INSERT INTO t (id, name) VALUES (2, ?)', ['lost']);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect((await db.all('SELECT id FROM t')).map((r) => r.id)).toEqual([1]);
  });

  it('returns the callback result', async () => {
    const db = await fresh();
    const out = await db.transaction(async (tx) => {
      await tx.run('INSERT INTO t (id) VALUES (7)');
      return (await tx.get<{ c: number }>('SELECT COUNT(*) AS c FROM t'))?.c;
    });
    expect(out).toBe(1);
  });

  it('serialises transactions so statements never interleave', async () => {
    const db = await fresh();
    await db.run('INSERT INTO t (id, n) VALUES (1, 0)');
    const bump = async () => {
      await db.transaction(async (tx) => {
        const row = await tx.get<{ n: number }>('SELECT n FROM t WHERE id = 1');
        await new Promise((resolve) => setTimeout(resolve, 2));
        await tx.run('UPDATE t SET n = ? WHERE id = 1', [(row?.n ?? 0) + 1]);
      });
    };
    await Promise.all([bump(), bump(), bump(), bump(), bump()]);
    expect((await db.get<{ n: number }>('SELECT n FROM t WHERE id = 1'))?.n).toBe(5);
  });

  it('makes outside statements wait for an open transaction', async () => {
    const db = await fresh();
    const order: string[] = [];
    const tx = db.transaction(async (inner) => {
      await inner.run('INSERT INTO t (id) VALUES (1)');
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push('tx done');
    });
    const outside = db.get('SELECT id FROM t WHERE id = 1').then((row) => {
      order.push(row ? 'outside saw row' : 'outside saw nothing');
    });
    await Promise.all([tx, outside]);
    expect(order).toEqual(['tx done', 'outside saw row']);
  });

  it('refuses the outer driver inside a transaction callback instead of deadlocking', async () => {
    const db = await fresh();
    await expect(
      db.transaction(async () => {
        await db.run('INSERT INTO t (id) VALUES (1)');
      }),
    ).rejects.toThrow(/use the `tx` argument/);
    // the failed callback rolled back and released the lock
    expect(await db.all('SELECT id FROM t')).toEqual([]);
  });

  it('supports nested transactions through savepoints', async () => {
    const db = await fresh();
    await db.transaction(async (tx) => {
      await tx.run('INSERT INTO t (id) VALUES (1)');
      await expect(
        tx.transaction(async (inner) => {
          await inner.run('INSERT INTO t (id) VALUES (2)');
          throw new Error('inner');
        }),
      ).rejects.toThrow('inner');
      await tx.transaction(async (inner) => {
        await inner.run('INSERT INTO t (id) VALUES (3)');
      });
    });
    expect((await db.all('SELECT id FROM t ORDER BY id')).map((r) => r.id)).toEqual([1, 3]);
  });

  it('exposes PRAGMA user_version', async () => {
    const db = await fresh();
    await db.exec('PRAGMA user_version = 4');
    expect((await db.get<{ user_version: number }>('PRAGMA user_version'))?.user_version).toBe(4);
  });
});
