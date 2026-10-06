import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { packagePath } from '../core/paths.js';
import type { Database, Queryable } from './database.js';

export const MIGRATIONS_DIR = packagePath('db/migrations');
/** Creates the table the migrator records applied migrations in. */
const BOOTSTRAP_FILE = packagePath('db/bootstrap/schema_migrations.sql');

const MIGRATION_FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;

interface Migration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

interface AppliedRow {
  version: number;
  name: string;
  checksum: string;
}

function loadMigrations(dir: string): Migration[] {
  const migrations = readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .map((name) => {
      const match = MIGRATION_FILE.exec(name);
      if (!match) {
        throw new Error(`Migration file '${name}' must be named like 0001_description.sql.`);
      }
      const sql = readFileSync(join(dir, name), 'utf8');
      return { version: Number(match[1]), name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    })
    .sort((a, b) => a.version - b.version);
  migrations.forEach((migration, index) => {
    const previous = migrations[index - 1];
    if (previous?.version === migration.version) {
      throw new Error(`Migrations '${previous.name}' and '${migration.name}' have the same version.`);
    }
  });
  return migrations;
}

// Applied migrations are history: the files on disk must still match what was run.
function verifyApplied(applied: AppliedRow[], migrations: Migration[]): void {
  const byVersion = new Map(migrations.map((migration) => [migration.version, migration]));
  const latestKnown = migrations.at(-1)?.version ?? 0;
  const latestApplied = applied.at(-1)?.version ?? 0;
  if (latestApplied > latestKnown) {
    throw new Error(
      `Database is at schema version ${latestApplied} but this server only knows version ${latestKnown}; ` +
        'it was migrated by a newer version of the server.',
    );
  }
  for (const row of applied) {
    const migration = byVersion.get(row.version);
    if (!migration) {
      throw new Error(`Migration '${row.name}' was applied to this database but its file is missing.`);
    }
    if (migration.checksum !== row.checksum) {
      throw new Error(
        `Migration '${migration.name}' has changed since it was applied. Applied migrations must never be ` +
          'edited; restore the file and put the change in a new migration.',
      );
    }
  }
  const appliedVersions = new Set(applied.map((row) => row.version));
  const skipped = migrations.find((migration) => migration.version < latestApplied && !appliedVersions.has(migration.version));
  if (skipped) {
    throw new Error(
      `Migration '${skipped.name}' is out of order: version ${latestApplied} is already applied. ` +
        'Give it the next unused number.',
    );
  }
}

/** Serialises migration runs across processes. An arbitrary constant, unique to this application. */
const MIGRATION_LOCK = 4_815_162_342;

const SELECT_APPLIED = 'SELECT version, name, checksum FROM schema_migrations ORDER BY version';

async function lockAndReadApplied(tx: Queryable): Promise<AppliedRow[]> {
  // Held until this transaction ends, so two deploys cannot apply the same migration.
  await tx.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
  await tx.exec(readFileSync(BOOTSTRAP_FILE, 'utf8'));
  return tx.query<AppliedRow>(SELECT_APPLIED);
}

/**
 * Applies every migration in `dir` that this database has not seen yet and returns the versions applied.
 * Only files named NNNN_description.sql directly inside `dir` are migrations; nothing else is read.
 * Run it from `npm run db:migrate` with the table owner's connection, never from the serving process.
 */
export async function migrate(db: Database, dir: string = MIGRATIONS_DIR): Promise<number[]> {
  const migrations = loadMigrations(dir);
  const applied: number[] = [];
  // One transaction per migration: a failure undoes only that migration.
  for (const migration of migrations) {
    await db.transaction(async (tx) => {
      const done = await lockAndReadApplied(tx);
      verifyApplied(done, migrations);
      if (done.some((row) => row.version === migration.version)) return;
      try {
        await tx.exec(migration.sql);
      } catch (cause) {
        throw new Error(`Migration '${migration.name}' failed: ${(cause as Error).message}`, { cause });
      }
      await tx.query('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES ($1, $2, $3, $4)', [
        migration.version,
        migration.name,
        migration.checksum,
        new Date().toISOString(),
      ]);
      applied.push(migration.version);
    });
  }
  if (migrations.length === 0) {
    await db.transaction(async (tx) => verifyApplied(await lockAndReadApplied(tx), migrations));
  }
  return applied;
}

/**
 * Throws unless the database has exactly the migrations in `dir` applied. The serving process calls
 * this at startup and for readiness checks; it never changes the schema itself.
 */
export async function assertSchemaCurrent(db: Queryable, dir: string = MIGRATIONS_DIR): Promise<void> {
  const migrations = loadMigrations(dir);
  let applied: AppliedRow[];
  try {
    applied = await db.query<AppliedRow>(SELECT_APPLIED);
  } catch (cause) {
    // 42P01: the table does not exist, so nothing was ever migrated.
    if ((cause as { code?: unknown }).code !== '42P01') throw cause;
    applied = [];
  }
  verifyApplied(applied, migrations);
  const appliedVersions = new Set(applied.map((row) => row.version));
  const pending = migrations.filter((migration) => !appliedVersions.has(migration.version));
  if (pending.length > 0) {
    throw new Error(
      `Database schema is behind: ${pending.map((migration) => `'${migration.name}'`).join(', ')} not applied. ` +
        'Run `npm run db:migrate`.',
    );
  }
}
