import { PGlite } from '@electric-sql/pglite';
import type { Database, Queryable } from '../../src/storage/database.js';

/**
 * A real Postgres running inside the test process, behind the interface the server uses for its
 * connection pool. It has one connection, so work is queued: a transaction holds the queue until it
 * ends, which is how a pool behaves when every other connection is waiting on the same rows.
 */
export async function openTestDatabase(): Promise<Database> {
  const pg = await PGlite.create();
  let queue: Promise<unknown> = Promise.resolve();

  function queued<T>(work: () => Promise<T>): Promise<T> {
    const result = queue.then(work);
    queue = result.catch(() => {});
    return result;
  }

  const direct: Queryable = {
    async query<Row>(text: string, params: readonly unknown[] = []) {
      const result = await pg.query<Row>(text, params as unknown[]);
      return result.rows;
    },
    async exec(sql: string) {
      await pg.exec(sql);
    },
  };

  return {
    query: (text, params) => queued(() => direct.query(text, params)),
    exec: (sql) => queued(() => direct.exec(sql)),
    transaction: (fn) =>
      queued(async () => {
        await pg.exec('BEGIN');
        try {
          const result = await fn(direct);
          await pg.exec('COMMIT');
          return result;
        } catch (error) {
          await pg.exec('ROLLBACK');
          throw error;
        }
      }),
    close: () => pg.close(),
  };
}
