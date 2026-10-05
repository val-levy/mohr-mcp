import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { packagePath } from '../core/paths.js';
import { type Db, tx } from './database.js';

export const SEEDS_DIR = packagePath('db/seeds');

/**
 * Loads every .sql file in `dir`, in name order, and returns the file names. All files load or none do.
 * Seeds are sample data, never schema: this runs only on request (`npm run db:seed`), never on startup,
 * and nothing records that it ran, so seed files must be safe to load twice (INSERT OR IGNORE).
 */
export function seed(db: Db, dir: string = SEEDS_DIR): string[] {
  const names = readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  tx(db, () => {
    for (const name of names) {
      try {
        db.exec(readFileSync(join(dir, name), 'utf8'));
      } catch (cause) {
        throw new Error(`Seed '${name}' failed: ${(cause as Error).message}`, { cause });
      }
    }
  });
  return names;
}
