import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/storage/database.js';
import { MIGRATIONS_DIR, migrate } from '../src/storage/migrator.js';

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'coach-migrations-'));
  db = new Database(':memory:');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, sql: string): void {
  writeFileSync(join(dir, name), sql);
}

function applied(): Array<{ version: number; name: string }> {
  return db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all() as Array<{
    version: number;
    name: string;
  }>;
}

function tables(): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

describe('migrate', () => {
  it('applies migrations in version order and records each one', () => {
    write('0002_add_b.sql', 'CREATE TABLE b (a_id INTEGER REFERENCES a(id));');
    write('0001_add_a.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
    expect(migrate(db, dir)).toEqual([1, 2]);
    expect(applied()).toEqual([
      { version: 1, name: '0001_add_a.sql' },
      { version: 2, name: '0002_add_b.sql' },
    ]);
    expect(tables()).toEqual(['a', 'b', 'schema_migrations']);
  });

  it('does nothing when every migration is already applied', () => {
    write('0001_add_a.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
    migrate(db, dir);
    expect(migrate(db, dir)).toEqual([]);
    expect(applied()).toHaveLength(1);
  });

  it('applies only the migrations added since the last run', () => {
    write('0001_add_a.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
    migrate(db, dir);
    write('0002_add_b.sql', 'CREATE TABLE b (id INTEGER PRIMARY KEY);');
    expect(migrate(db, dir)).toEqual([2]);
    expect(tables()).toEqual(['a', 'b', 'schema_migrations']);
  });

  it('rolls a failing migration back completely and keeps the earlier ones', () => {
    write('0001_add_a.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
    write('0002_broken.sql', 'CREATE TABLE b (id INTEGER PRIMARY KEY); CREATE TABLE a (id INTEGER);');
    expect(() => migrate(db, dir)).toThrow(/0002_broken\.sql/);
    expect(applied()).toEqual([{ version: 1, name: '0001_add_a.sql' }]);
    expect(tables()).toEqual(['a', 'schema_migrations']);
  });

  it('refuses a database migrated by a newer version of the server', () => {
    write('0001_add_a.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
    write('0002_add_b.sql', 'CREATE TABLE b (id INTEGER PRIMARY KEY);');
    migrate(db, dir);
    rmSync(join(dir, '0002_add_b.sql'));
    expect(() => migrate(db, dir)).toThrow(/newer version/);
  });

  it('refuses two migrations with the same version', () => {
    write('0001_add_a.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
    write('0001_add_b.sql', 'CREATE TABLE b (id INTEGER PRIMARY KEY);');
    expect(() => migrate(db, dir)).toThrow(/same version/);
    expect(tables()).toEqual([]);
  });

  it('refuses a .sql file that is not named like a migration', () => {
    write('add_a.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
    expect(() => migrate(db, dir)).toThrow(/add_a\.sql/);
  });

  it('ignores files that are not .sql', () => {
    write('0001_add_a.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
    write('README.md', 'notes');
    expect(migrate(db, dir)).toEqual([1]);
  });
});

describe('the shipped migrations', () => {
  it('create the full schema on an empty database', () => {
    expect(migrate(db, MIGRATIONS_DIR)).toEqual([1]);
    expect(tables()).toEqual([
      'candidates',
      'interview_events',
      'interviews',
      'jobs',
      'schema_migrations',
      'skill_assessment_history',
      'skill_assessments',
    ]);
  });
});
