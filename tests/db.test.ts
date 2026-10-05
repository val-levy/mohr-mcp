import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type Db, defaultDbPath, newId, now, openDb, tx } from '../src/storage/database.js';

function seedEvent(db: Db): void {
  const t = now();
  db.prepare(
    "INSERT INTO candidates (id, name, profile, created_at, updated_at) VALUES ('cand_1', 'Val', '{}', ?, ?)",
  ).run(t, t);
  db.prepare(
    "INSERT INTO jobs (id, candidate_id, company, title, description, requirements, metadata, created_at) VALUES ('job_1', 'cand_1', 'Acme', 'SWE', 'Build things', '[]', '{}', ?)",
  ).run(t);
  db.prepare(
    "INSERT INTO interviews (id, candidate_id, job_id, type, status, started_at) VALUES ('int_1', 'cand_1', 'job_1', 'technical', 'active', ?)",
  ).run(t);
  db.prepare(
    "INSERT INTO interview_events (interview_id, type, data, created_at) VALUES ('int_1', 'question_asked', '{}', ?)",
  ).run(t);
}

describe('openDb', () => {
  it('creates the six data tables and the migration log', () => {
    const db = openDb(':memory:');
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(names).toEqual([
      'candidates',
      'interview_events',
      'interviews',
      'jobs',
      'schema_migrations',
      'skill_assessment_history',
      'skill_assessments',
    ]);
    db.close();
  });

  it('enforces foreign keys', () => {
    const db = openDb(':memory:');
    expect(() =>
      db
        .prepare(
          "INSERT INTO jobs (id, candidate_id, company, title, description, requirements, metadata, created_at) VALUES ('job_1', 'cand_missing', 'Acme', 'SWE', 'x', '[]', '{}', 't')",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
    db.close();
  });

  it('rejects any status other than active or completed', () => {
    const db = openDb(':memory:');
    seedEvent(db);
    expect(() => db.prepare("UPDATE interviews SET status = 'created'").run()).toThrow(/CHECK/);
    db.close();
  });

  it('makes interview_events append-only', () => {
    const db = openDb(':memory:');
    seedEvent(db);
    expect(() => db.prepare("UPDATE interview_events SET type = 'evaluation'").run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM interview_events').run()).toThrow(/append-only/);
    expect(db.prepare('SELECT type FROM interview_events').all()).toEqual([{ type: 'question_asked' }]);
    db.close();
  });
});

describe('openDb on disk', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('creates missing parent directories and keeps data when reopened', () => {
    dir = mkdtempSync(join(tmpdir(), 'coach-'));
    const path = join(dir, 'nested', 'deeper', 'coach.db');
    const first = openDb(path);
    seedEvent(first);
    first.close();

    const second = openDb(path);
    expect(second.prepare('SELECT name FROM candidates').all()).toEqual([{ name: 'Val' }]);
    expect(second.prepare('SELECT count(*) AS n FROM interview_events').get()).toEqual({ n: 1 });
    second.close();
  });

  it.skipIf(process.platform === 'win32')('keeps the database private to the current user', () => {
    dir = mkdtempSync(join(tmpdir(), 'coach-'));
    const path = join(dir, 'private', 'coach.db');
    const db = openDb(path);
    seedEvent(db);
    expect(statSync(join(dir, 'private')).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(`${path}-wal`).mode & 0o777).toBe(0o600);
    db.close();
  });

  it.skipIf(process.platform === 'win32')('tightens a database and sidecar files left readable by others', () => {
    dir = mkdtempSync(join(tmpdir(), 'coach-'));
    const path = join(dir, 'coach.db');
    const first = openDb(path);
    seedEvent(first);
    const files = [path, `${path}-wal`, `${path}-shm`];
    for (const file of files) chmodSync(file, 0o644);
    const second = openDb(path);
    for (const file of files) expect(statSync(file).mode & 0o777).toBe(0o600);
    second.close();
    first.close();
  });
});

describe('defaultDbPath', () => {
  afterEach(() => {
    delete process.env.COACH_DB_PATH;
  });

  it('uses COACH_DB_PATH when set', () => {
    process.env.COACH_DB_PATH = '/tmp/custom/coach.db';
    expect(defaultDbPath()).toBe('/tmp/custom/coach.db');
  });

  it('falls back to ~/.interview-coach/coach.db', () => {
    delete process.env.COACH_DB_PATH;
    expect(defaultDbPath()).toMatch(/\.interview-coach[/\\]coach\.db$/);
  });
});

describe('tx', () => {
  it('returns the callback result and commits', () => {
    const db = openDb(':memory:');
    const result = tx(db, () => {
      seedEvent(db);
      return 42;
    });
    expect(result).toBe(42);
    expect(db.prepare('SELECT count(*) AS n FROM candidates').get()).toEqual({ n: 1 });
    db.close();
  });

  it('rolls everything back when the callback throws', () => {
    const db = openDb(':memory:');
    expect(() =>
      tx(db, () => {
        seedEvent(db);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(db.prepare('SELECT count(*) AS n FROM candidates').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM interview_events').get()).toEqual({ n: 0 });
    db.close();
  });
});

describe('newId', () => {
  it('produces a prefixed 16-hex-character id', () => {
    expect(newId('cand')).toMatch(/^cand_[0-9a-f]{16}$/);
    expect(newId('job')).toMatch(/^job_[0-9a-f]{16}$/);
    expect(newId('int')).toMatch(/^int_[0-9a-f]{16}$/);
    expect(newId('int')).not.toBe(newId('int'));
  });
});
