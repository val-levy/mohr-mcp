import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './db.js';

// Resolves to <package root>/migrations from both src/ and the compiled dist/.
export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

const MIGRATION_FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;

interface Migration {
  version: number;
  name: string;
}

function listMigrations(dir: string): Migration[] {
  const migrations = readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .map((name) => {
      const match = MIGRATION_FILE.exec(name);
      if (!match) {
        throw new Error(`Migration file '${name}' must be named like 0001_description.sql.`);
      }
      return { version: Number(match[1]), name };
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

/** Applies every migration in `dir` that this database has not seen yet; returns the versions applied. */
export function migrate(db: Db, dir: string = MIGRATIONS_DIR): number[] {
  const migrations = listMigrations(dir);
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
  );
  const currentVersion = db.prepare('SELECT coalesce(max(version), 0) AS current FROM schema_migrations').pluck();
  const record = db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)');

  const latest = migrations.at(-1)?.version ?? 0;
  const current = currentVersion.get() as number;
  if (current > latest) {
    throw new Error(
      `Database is at schema version ${current} but this server only knows version ${latest}; ` +
        'it was migrated by a newer version of the server.',
    );
  }

  const applied: number[] = [];
  for (const { version, name } of migrations) {
    // One transaction per migration: a failure undoes only that migration. IMMEDIATE takes the
    // write lock before the version check, so two servers starting together cannot both apply it.
    db.transaction(() => {
      if (version <= (currentVersion.get() as number)) return;
      try {
        db.exec(readFileSync(join(dir, name), 'utf8'));
      } catch (cause) {
        throw new Error(`Migration '${name}' failed: ${(cause as Error).message}`, { cause });
      }
      record.run(version, name, new Date().toISOString());
      applied.push(version);
    }).immediate();
  }
  return applied;
}
