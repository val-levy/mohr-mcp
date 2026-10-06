import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SEEDS_DIR, seed } from '../src/storage/seeder.js';
import { ACCOUNT, ok, rows, useDb } from './helpers.js';

/** The account the shipped seed data belongs to. */
const DEMO_ACCOUNT = '00000000-0000-4000-8000-000000000001';

const getDb = useDb();
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'coach-seeds-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, sql: string): void {
  writeFileSync(join(dir, name), sql);
}

function insert(id: string, name: string): string {
  return `INSERT INTO accounts (id, created_at, last_seen_at) VALUES ('${ACCOUNT}', now(), now()) ON CONFLICT DO NOTHING;
    INSERT INTO candidates (id, account_id, name, name_key, profile, created_at, updated_at)
    VALUES ('${id}', '${ACCOUNT}', '${name}', lower('${name}'), '{}', now(), now());`;
}

async function names(): Promise<string[]> {
  const found = await rows<{ name: string }>('SELECT name FROM candidates ORDER BY name');
  return found.map((row) => row.name);
}

describe('seed', () => {
  it('loads every seed file in name order and reports them', async () => {
    write('0002_sam.sql', insert('cand_2', 'Sam'));
    write('0001_val.sql', insert('cand_1', 'Val'));
    expect(await seed(getDb(), dir)).toEqual(['0001_val.sql', '0002_sam.sql']);
    expect(await names()).toEqual(['Sam', 'Val']);
  });

  it('loads nothing when one seed file fails', async () => {
    write('0001_val.sql', insert('cand_1', 'Val'));
    write('0002_broken.sql', 'INSERT INTO no_such_table VALUES (1);');
    await expect(seed(getDb(), dir)).rejects.toThrow(/0002_broken\.sql/);
    expect(await names()).toEqual([]);
  });

  it('ignores files that are not .sql', async () => {
    write('0001_val.sql', insert('cand_1', 'Val'));
    write('notes.md', 'not sql');
    expect(await seed(getDb(), dir)).toEqual(['0001_val.sql']);
  });
});

describe('the shipped seeds', () => {
  it('are never loaded by migrating the database', async () => {
    expect(await names()).toEqual([]);
  });

  it('load data the tools can read, and can be loaded twice', async () => {
    await seed(getDb(), SEEDS_DIR);
    await seed(getDb(), SEEDS_DIR);
    const { candidates } = await ok('list_candidates', {}, DEMO_ACCOUNT);
    expect(candidates).toHaveLength(1);
    const candidateId = candidates[0].candidate_id;
    const profile = await ok('get_candidate_profile', { candidate_id: candidateId }, DEMO_ACCOUNT);
    expect(profile.skills.length).toBeGreaterThan(0);
    const { jobs } = await ok('list_target_jobs', { candidate_id: candidateId }, DEMO_ACCOUNT);
    expect(jobs).toHaveLength(1);
    expect((await ok('get_target_job', { job_id: jobs[0].job_id }, DEMO_ACCOUNT)).requirements.length).toBeGreaterThan(0);
  });

  it('belong to the development account only', async () => {
    await seed(getDb(), SEEDS_DIR);
    expect((await ok('list_candidates')).candidates).toEqual([]);
  });
});
