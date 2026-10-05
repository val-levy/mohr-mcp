import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from './migrator.js';

export type Db = Database.Database;

export function defaultDbPath(): string {
  return process.env.COACH_DB_PATH || join(homedir(), '.interview-coach', 'coach.db');
}

export function openDb(path: string): Db {
  const onDisk = path !== ':memory:';
  // The database holds resumes and interview answers: keep it private to this user.
  if (onDisk) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // Create the file owner-only up front, so it is never briefly readable by others.
    closeSync(openSync(path, 'a', 0o600));
    // A database from an earlier run, and its WAL sidecar files, may have looser modes.
    for (const file of [path, `${path}-wal`, `${path}-shm`]) {
      if (existsSync(file)) chmodSync(file, 0o600);
    }
  }
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

export function tx<T>(db: Db, fn: () => T): T {
  return db.transaction(fn).immediate();
}

export function newId(prefix: 'cand' | 'job' | 'int'): string {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

export function now(): string {
  return new Date().toISOString();
}
