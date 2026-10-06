import { afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest';
import type { ErrorBody } from '../src/core/errors.js';
import { type Envelope, callTool } from '../src/core/envelope.js';
import { RateLimiter } from '../src/core/rate-limit.js';
import { tools } from '../src/registry.js';
import type { Database } from '../src/storage/database.js';
import { migrate } from '../src/storage/migrator.js';
import { openTestDatabase } from './support/pglite.js';

/** The account every tool call is made for unless a test names another. */
export const ACCOUNT = '11111111-1111-4111-8111-111111111111';
export const OTHER_ACCOUNT = '22222222-2222-4222-8222-222222222222';

let db: Database;
let limiter: RateLimiter;

/**
 * Gives the tests in a file one migrated database, emptied before each test, and a clock fixed at
 * 2026-01-01. Starting Postgres is the slow part, so it happens once per file rather than per test.
 */
export function useDb(): () => Database {
  beforeAll(async () => {
    db = await openTestDatabase();
    await migrate(db);
  });
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    limiter = new RateLimiter(1_000_000);
    await db.exec('TRUNCATE accounts, deleted_accounts RESTART IDENTITY CASCADE');
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  afterAll(async () => {
    await db.close();
  });
  return () => db;
}

export function advance(ms = 1000): void {
  vi.setSystemTime(Date.now() + ms);
}

export function call(name: string, args?: unknown, accountId: string = ACCOUNT): Promise<Envelope> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`No tool named '${name}' is registered.`);
  return callTool({ db, limiter }, accountId, tool, args);
}

// Returns `any` so tests can read fields of the result without casting.
export async function ok(name: string, args?: unknown, accountId: string = ACCOUNT): Promise<any> {
  const env = await call(name, args, accountId);
  if (!env.success) throw new Error(`${name} failed: ${env.error.code} ${env.error.message}`);
  return env.data;
}

export async function fail(name: string, args?: unknown, accountId: string = ACCOUNT): Promise<ErrorBody> {
  const env = await call(name, args, accountId);
  if (env.success) throw new Error(`${name} unexpectedly succeeded`);
  return env.error;
}

/** Reads the tables directly, as their owner, to check what a tool call really stored. */
export function rows<Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<Row[]> {
  return db.query<Row>(sql, params);
}
