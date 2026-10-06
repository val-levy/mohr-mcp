#!/usr/bin/env node
import { requireEnv } from './config.js';
import { openDatabase } from './storage/database.js';
import { seed } from './storage/seeder.js';

try {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('seeds are demo data and are never loaded when NODE_ENV is production.');
  }
  const db = openDatabase(requireEnv('MIGRATION_DATABASE_URL'));
  try {
    const loaded = await seed(db);
    console.error(`Loaded ${loaded.length} seed file(s): ${loaded.join(', ')}`);
  } finally {
    await db.close();
  }
} catch (error) {
  console.error(`interview-coach: seeding failed: ${(error as Error).message}`);
  process.exit(1);
}
