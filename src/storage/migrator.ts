import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { packagePath } from '../core/paths.js';
import type { Db } from './database.js';

export const MIGRATIONS_DIR = packagePath('db/migrations');

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

/**
 * Applies every migration in `dir` that this database has not seen yet and returns the versions applied.
 * Only files named NNNN_description.sql directly inside `dir` are migrations; nothing else is read.
 */
export function migrate(db: Db, dir: string = MIGRATIONS_DIR): number[] {
  const migrations = loadMigrations(dir);
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version     INTEGER PRIMARY KEY,
       name        TEXT NOT NULL,
       checksum    TEXT NOT NULL,
       applied_at  TEXT NOT NULL
     )`,
  );
  const selectApplied = db.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version');
  const record = db.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)');

  const applied: number[] = [];
  for (const migration of migrations) {
    // One transaction per migration: a failure undoes only that migration. IMMEDIATE takes the write
    // lock before the checks, so two servers starting together cannot both apply the same migration.
    db.transaction(() => {
      const done = selectApplied.all() as AppliedRow[];
      verifyApplied(done, migrations);
      if (done.some((row) => row.version === migration.version)) return;
      try {
        db.exec(migration.sql);
      } catch (cause) {
        throw new Error(`Migration '${migration.name}' failed: ${(cause as Error).message}`, { cause });
      }
      record.run(migration.version, migration.name, migration.checksum, new Date().toISOString());
      applied.push(migration.version);
    }).immediate();
  }
  if (migrations.length === 0) verifyApplied(selectApplied.all() as AppliedRow[], migrations);
  return applied;
}
