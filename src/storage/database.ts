import { randomBytes } from 'node:crypto';
import pg from 'pg';

/** Runs SQL. Inside `Database.transaction` every call uses the same connection. */
export interface Queryable {
  /** One statement with `$1`-style parameters. */
  query<Row = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<Row[]>;
  /** One or more statements without parameters, e.g. a migration file. */
  exec(sql: string): Promise<void>;
}

export interface Database extends Queryable {
  /** Runs `fn` in one transaction: committed when it resolves, rolled back when it throws. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const STATEMENT_TIMEOUT_MS = 10_000;

/**
 * Runs `fn` in a transaction that can only see and write the rows of `accountId`.
 * The settings last for this transaction only, so the connection is safe to hand back to a pool.
 */
export function withAccount<T>(db: Database, accountId: string, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    // Dropping to coach_app applies row security even if the connection was opened as the table owner.
    await tx.query(
      `SELECT set_config('role', 'coach_app', true),
              set_config('app.account_id', $1, true),
              set_config('statement_timeout', $2, true)`,
      [accountId, String(STATEMENT_TIMEOUT_MS)],
    );
    return fn(tx);
  });
}

function queryable(client: pg.Pool | pg.PoolClient): Queryable {
  return {
    async query<Row>(text: string, params: readonly unknown[] = []) {
      const result = await client.query(text, params as unknown[]);
      return result.rows as Row[];
    },
    async exec(sql: string) {
      await client.query(sql);
    },
  };
}

export function openDatabase(connectionString: string): Database {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
  // An idle connection dropped by the server must not crash the process; the pool replaces it.
  pool.on('error', () => {});
  return {
    ...queryable(pool),
    async transaction(fn) {
      const client = await pool.connect();
      let broken = false;
      try {
        await client.query('BEGIN');
        const result = await fn(queryable(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          broken = true;
        }
        throw error;
      } finally {
        client.release(broken);
      }
    },
    close: () => pool.end(),
  };
}

export function newId(prefix: 'cand' | 'job' | 'int'): string {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

export function now(): string {
  return new Date().toISOString();
}

/** A timestamp column as the ISO 8601 UTC string every tool returns. */
export function iso(value: Date): string;
export function iso(value: Date | null): string | null;
export function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}
