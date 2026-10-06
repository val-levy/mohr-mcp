import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { packagePath } from '../core/paths.js';
import type { Database } from './database.js';

export const SEEDS_DIR = packagePath('db/seeds');

/**
 * Loads every .sql file in `dir`, in name order, and returns the file names. All files load or none do.
 * Seeds are sample data for development, never schema: this runs only on request (`npm run db:seed`)
 * with the table owner's connection, and nothing records that it ran, so seed files must be safe to
 * load twice (ON CONFLICT DO NOTHING).
 */
export async function seed(db: Database, dir: string = SEEDS_DIR): Promise<string[]> {
  const names = readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  await db.transaction(async (tx) => {
    for (const name of names) {
      try {
        await tx.exec(readFileSync(join(dir, name), 'utf8'));
      } catch (cause) {
        throw new Error(`Seed '${name}' failed: ${(cause as Error).message}`, { cause });
      }
    }
  });
  return names;
}
