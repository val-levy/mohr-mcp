#!/usr/bin/env node
import { defaultDbPath, openDb } from './storage/database.js';
import { seed } from './storage/seeder.js';

const path = defaultDbPath();
try {
  const db = openDb(path);
  const loaded = seed(db);
  db.close();
  console.error(`Loaded ${loaded.length} seed file(s) into ${path}: ${loaded.join(', ')}`);
} catch (error) {
  console.error(`interview-coach: seeding failed: ${(error as Error).message}`);
  process.exit(1);
}
