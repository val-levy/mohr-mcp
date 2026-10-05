import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Db, openDb } from '../src/storage/database.js';
import { SEEDS_DIR, seed } from '../src/storage/seeder.js';
import { ok } from './helpers.js';

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'coach-seeds-'));
  db = openDb(':memory:');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, sql: string): void {
  writeFileSync(join(dir, name), sql);
}

function insert(id: string, name: string): string {
  return `INSERT INTO candidates (id, name, name_key, profile, created_at, updated_at) VALUES ('${id}', '${name}', lower('${name}'), '{}', 't', 't');`;
}

function names(): string[] {
  const rows = db.prepare('SELECT name FROM candidates ORDER BY name').all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

describe('seed', () => {
  it('loads every seed file in name order and reports them', () => {
    write('0002_sam.sql', insert('cand_2', 'Sam'));
    write('0001_val.sql', insert('cand_1', 'Val'));
    expect(seed(db, dir)).toEqual(['0001_val.sql', '0002_sam.sql']);
    expect(names()).toEqual(['Sam', 'Val']);
  });

  it('loads nothing when one seed file fails', () => {
    write('0001_val.sql', insert('cand_1', 'Val'));
    write('0002_broken.sql', 'INSERT INTO no_such_table VALUES (1);');
    expect(() => seed(db, dir)).toThrow(/0002_broken\.sql/);
    expect(names()).toEqual([]);
  });

  it('ignores files that are not .sql', () => {
    write('0001_val.sql', insert('cand_1', 'Val'));
    write('notes.md', 'not sql');
    expect(seed(db, dir)).toEqual(['0001_val.sql']);
  });
});

describe('the shipped seeds', () => {
  it('are never loaded by opening the database', () => {
    expect(names()).toEqual([]);
  });

  it('load data the tools can read, and can be loaded twice', () => {
    seed(db, SEEDS_DIR);
    seed(db, SEEDS_DIR);
    const { candidates } = ok(db, 'list_candidates');
    expect(candidates).toHaveLength(1);
    const profile = ok(db, 'get_candidate_profile', { candidate_id: candidates[0].candidate_id });
    expect(profile.skills.length).toBeGreaterThan(0);
    const { jobs } = ok(db, 'list_target_jobs', { candidate_id: candidates[0].candidate_id });
    expect(jobs).toHaveLength(1);
    expect(ok(db, 'get_target_job', { job_id: jobs[0].job_id }).requirements.length).toBeGreaterThan(0);
  });
});
