#!/usr/bin/env node
import { requireEnv } from './config.js';
import { openDatabase } from './storage/database.js';
import { migrate } from './storage/migrator.js';

try {
  // The owner's connection: the only one allowed to change the schema.
  const db = openDatabase(requireEnv('MIGRATION_DATABASE_URL'));
  try {
    const applied = await migrate(db);
    console.error(applied.length === 0 ? 'Schema is up to date.' : `Applied migration(s): ${applied.join(', ')}`);
  } finally {
    await db.close();
  }
} catch (error) {
  console.error(`interview-coach: migration failed: ${(error as Error).message}`);
  process.exit(1);
}
