import { afterEach, beforeEach, vi } from 'vitest';
import { type Db, openDb } from '../src/storage/database.js';
import type { ErrorBody } from '../src/core/errors.js';
import { type Envelope, callTool } from '../src/core/envelope.js';
import { tools } from '../src/registry.js';

export function useDb(): () => Db {
  let db: Db;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    db = openDb(':memory:');
  });
  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });
  return () => db;
}

export function advance(ms = 1000): void {
  vi.setSystemTime(Date.now() + ms);
}

export function call(db: Db, name: string, args?: unknown): Envelope {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`No tool named '${name}' is registered.`);
  return callTool(db, tool, args);
}

// Returns `any` so tests can read fields of the result without casting.
export function ok(db: Db, name: string, args?: unknown): any {
  const env = call(db, name, args);
  if (!env.success) throw new Error(`${name} failed: ${env.error.code} ${env.error.message}`);
  return env.data;
}

export function fail(db: Db, name: string, args?: unknown): ErrorBody {
  const env = call(db, name, args);
  if (env.success) throw new Error(`${name} unexpectedly succeeded`);
  return env.error;
}
