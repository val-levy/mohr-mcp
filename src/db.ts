import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';

export type Db = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS candidates (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL COLLATE NOCASE UNIQUE,
  resume      TEXT NOT NULL DEFAULT '',
  profile     TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,
  candidate_id  TEXT NOT NULL REFERENCES candidates(id),
  company       TEXT NOT NULL,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL,
  location      TEXT,
  requirements  TEXT NOT NULL,
  metadata      TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_by_candidate ON jobs(candidate_id);

CREATE TABLE IF NOT EXISTS interviews (
  id                TEXT PRIMARY KEY,
  candidate_id      TEXT NOT NULL REFERENCES candidates(id),
  job_id            TEXT NOT NULL REFERENCES jobs(id),
  type              TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('active', 'completed')),
  started_at        TEXT NOT NULL,
  finished_at       TEXT,
  overall_score     REAL,
  final_evaluation  TEXT
);
CREATE INDEX IF NOT EXISTS interviews_by_candidate ON interviews(candidate_id);

CREATE TABLE IF NOT EXISTS interview_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  interview_id  TEXT NOT NULL REFERENCES interviews(id),
  type          TEXT NOT NULL,
  data          TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_by_interview ON interview_events(interview_id);

CREATE TRIGGER IF NOT EXISTS interview_events_no_update
BEFORE UPDATE ON interview_events
BEGIN
  SELECT RAISE(ABORT, 'interview_events is append-only');
END;

CREATE TRIGGER IF NOT EXISTS interview_events_no_delete
BEFORE DELETE ON interview_events
BEGIN
  SELECT RAISE(ABORT, 'interview_events is append-only');
END;

CREATE TABLE IF NOT EXISTS skill_assessments (
  candidate_id  TEXT NOT NULL REFERENCES candidates(id),
  skill         TEXT NOT NULL,
  score         REAL NOT NULL,
  confidence    REAL NOT NULL,
  evidence      TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (candidate_id, skill)
);

CREATE TABLE IF NOT EXISTS skill_assessment_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id  TEXT NOT NULL REFERENCES candidates(id),
  skill         TEXT NOT NULL,
  score         REAL NOT NULL,
  confidence    REAL NOT NULL,
  evidence      TEXT NOT NULL,
  interview_id  TEXT REFERENCES interviews(id),
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS skill_history_by_candidate ON skill_assessment_history(candidate_id);
`;

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
  db.exec(SCHEMA);
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
