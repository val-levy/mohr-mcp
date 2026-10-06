import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../src/storage/database.js';
import { MIGRATIONS_DIR, assertSchemaCurrent, migrate } from '../src/storage/migrator.js';
import { openTestDatabase } from './support/pglite.js';

let dir: string;
let db: Database;

// Migrations change the schema, so unlike the tool tests each of these starts from an empty database.
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'coach-migrations-'));
  db = await openTestDatabase();
});

afterEach(async () => {
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, sql: string): void {
  writeFileSync(join(dir, name), sql);
}

function applied(): Promise<Array<{ version: number; name: string }>> {
  return db.query('SELECT version, name FROM schema_migrations ORDER BY version');
}

async function tables(): Promise<string[]> {
  const found = await db.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  return found.map((row) => row.tablename);
}

const ADD_A = 'CREATE TABLE a (id integer PRIMARY KEY);';
const ADD_B = 'CREATE TABLE b (id integer PRIMARY KEY);';

describe('migrate', () => {
  it('applies migrations in version order and records each one', async () => {
    write('0002_add_b.sql', 'CREATE TABLE b (a_id integer REFERENCES a(id));');
    write('0001_add_a.sql', ADD_A);
    expect(await migrate(db, dir)).toEqual([1, 2]);
    expect(await applied()).toEqual([
      { version: 1, name: '0001_add_a.sql' },
      { version: 2, name: '0002_add_b.sql' },
    ]);
    expect(await tables()).toEqual(['a', 'b', 'schema_migrations']);
  });

  it('does nothing when every migration is already applied', async () => {
    write('0001_add_a.sql', ADD_A);
    await migrate(db, dir);
    expect(await migrate(db, dir)).toEqual([]);
    expect(await applied()).toHaveLength(1);
  });

  it('applies only the migrations added since the last run', async () => {
    write('0001_add_a.sql', ADD_A);
    await migrate(db, dir);
    write('0002_add_b.sql', ADD_B);
    expect(await migrate(db, dir)).toEqual([2]);
    expect(await tables()).toEqual(['a', 'b', 'schema_migrations']);
  });

  it('applies each migration once when two runs start together', async () => {
    write('0001_add_a.sql', ADD_A);
    write('0002_add_b.sql', ADD_B);
    const runs = await Promise.all([migrate(db, dir), migrate(db, dir)]);
    expect(runs.flat().sort()).toEqual([1, 2]);
    expect(await applied()).toHaveLength(2);
  });

  it('rolls a failing migration back completely and keeps the earlier ones', async () => {
    write('0001_add_a.sql', ADD_A);
    write('0002_broken.sql', `${ADD_B} CREATE TABLE a (id integer);`);
    await expect(migrate(db, dir)).rejects.toThrow(/0002_broken\.sql/);
    expect(await applied()).toEqual([{ version: 1, name: '0001_add_a.sql' }]);
    expect(await tables()).toEqual(['a', 'schema_migrations']);
  });

  it('refuses a database migrated by a newer version of the server', async () => {
    write('0001_add_a.sql', ADD_A);
    write('0002_add_b.sql', ADD_B);
    await migrate(db, dir);
    rmSync(join(dir, '0002_add_b.sql'));
    await expect(migrate(db, dir)).rejects.toThrow(/newer version/);
  });

  it('refuses two migrations with the same version', async () => {
    write('0001_add_a.sql', ADD_A);
    write('0001_add_b.sql', ADD_B);
    await expect(migrate(db, dir)).rejects.toThrow(/same version/);
    expect(await tables()).toEqual([]);
  });

  it('refuses a .sql file that is not named like a migration', async () => {
    write('add_a.sql', ADD_A);
    await expect(migrate(db, dir)).rejects.toThrow(/add_a\.sql/);
  });

  it('records a checksum of each applied migration', async () => {
    write('0001_add_a.sql', ADD_A);
    await migrate(db, dir);
    expect(await db.query('SELECT checksum FROM schema_migrations')).toEqual([
      { checksum: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ]);
  });

  it('refuses to run when an applied migration has been edited', async () => {
    write('0001_add_a.sql', ADD_A);
    await migrate(db, dir);
    write('0001_add_a.sql', 'CREATE TABLE a (id integer PRIMARY KEY, extra text);');
    write('0002_add_b.sql', ADD_B);
    await expect(migrate(db, dir)).rejects.toThrow(/0001_add_a\.sql.*changed/);
    expect(await tables()).toEqual(['a', 'schema_migrations']);
  });

  it('refuses to run when an applied migration file is missing', async () => {
    write('0001_add_a.sql', ADD_A);
    write('0002_add_b.sql', ADD_B);
    await migrate(db, dir);
    rmSync(join(dir, '0001_add_a.sql'));
    await expect(migrate(db, dir)).rejects.toThrow(/0001_add_a\.sql.*missing/);
  });

  it('refuses a migration numbered below one that is already applied', async () => {
    write('0002_add_b.sql', ADD_B);
    await migrate(db, dir);
    write('0001_add_a.sql', ADD_A);
    await expect(migrate(db, dir)).rejects.toThrow(/0001_add_a\.sql.*out of order/);
    expect(await tables()).toEqual(['b', 'schema_migrations']);
  });

  it('ignores files that are not .sql', async () => {
    write('0001_add_a.sql', ADD_A);
    write('README.md', 'notes');
    expect(await migrate(db, dir)).toEqual([1]);
  });
});

describe('assertSchemaCurrent', () => {
  it('accepts a fully migrated database and changes nothing', async () => {
    write('0001_add_a.sql', ADD_A);
    await migrate(db, dir);
    await expect(assertSchemaCurrent(db, dir)).resolves.toBeUndefined();
  });

  it('refuses a database that was never migrated, without creating anything', async () => {
    write('0001_add_a.sql', ADD_A);
    await expect(assertSchemaCurrent(db, dir)).rejects.toThrow(/0001_add_a\.sql.*db:migrate/);
    expect(await tables()).toEqual([]);
  });

  it('refuses a database that is missing the newest migration', async () => {
    write('0001_add_a.sql', ADD_A);
    await migrate(db, dir);
    write('0002_add_b.sql', ADD_B);
    await expect(assertSchemaCurrent(db, dir)).rejects.toThrow(/0002_add_b\.sql.*not applied/);
    expect(await tables()).toEqual(['a', 'schema_migrations']);
  });

  it('refuses a database whose applied migration was edited', async () => {
    write('0001_add_a.sql', ADD_A);
    await migrate(db, dir);
    write('0001_add_a.sql', `${ADD_A} -- edited`);
    await expect(assertSchemaCurrent(db, dir)).rejects.toThrow(/changed/);
  });
});

describe('the shipped migrations', () => {
  it('create the full schema on an empty database', async () => {
    expect(await migrate(db, MIGRATIONS_DIR)).toEqual([1]);
    expect(await tables()).toEqual([
      'accounts',
      'candidates',
      'interview_events',
      'interviews',
      'jobs',
      'schema_migrations',
      'skill_assessment_history',
      'skill_assessments',
    ]);
    await expect(assertSchemaCurrent(db)).resolves.toBeUndefined();
  });

  it('turn on row security for every table', async () => {
    await migrate(db, MIGRATIONS_DIR);
    expect(await db.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND NOT rowsecurity")).toEqual(
      [],
    );
  });
});
