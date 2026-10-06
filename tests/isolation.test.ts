import { describe, expect, it } from 'vitest';
import { deleteAccount } from '../src/accounts/accounts.js';
import { withAccount } from '../src/storage/database.js';
import { ACCOUNT, OTHER_ACCOUNT, call, fail, ok, rows, useDb } from './helpers.js';

const getDb = useDb();

const evaluation = {
  overall_score: 7,
  category_scores: { algorithms: 7 },
  strengths: ['s'],
  weaknesses: ['w'],
  recommendations: ['r'],
};
const graphs = { skill: 'graphs', score: 5, confidence: 0.8, evidence: 'One hint.' };

/** One of everything, owned by `accountId`. */
async function populate(accountId = ACCOUNT) {
  const candidateId: string = (await ok('create_candidate', { name: 'Val', resume: 'PRIVATE' }, accountId)).candidate_id;
  const jobId: string = (
    await ok('create_target_job', { candidate_id: candidateId, company: 'Acme', title: 'SWE', description: 'Build.' }, accountId)
  ).job_id;
  const interviewId: string = (
    await ok('create_interview', { candidate_id: candidateId, job_id: jobId, interview_type: 'technical' }, accountId)
  ).interview_id;
  await ok(
    'record_interview_event',
    { interview_id: interviewId, event: { type: 'question_asked', question: 'PRIVATE QUESTION' } },
    accountId,
  );
  await ok('update_skill_assessment', { candidate_id: candidateId, interview_id: interviewId, skills: [graphs] }, accountId);
  return { candidateId, jobId, interviewId };
}

const TABLES = ['candidates', 'jobs', 'interviews', 'interview_events', 'skill_assessments', 'skill_assessment_history'];

async function counts(): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const table of TABLES) {
    const [row] = await rows<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
    result[table] = row?.n ?? 0;
  }
  return result;
}

describe('another account', () => {
  it('sees empty lists', async () => {
    await populate();
    expect(await ok('list_candidates', {}, OTHER_ACCOUNT)).toEqual({ candidates: [], next_cursor: null });
  });

  it.each([
    ['get_candidate_profile', (ids: Ids) => ({ candidate_id: ids.candidateId }), 'CANDIDATE_NOT_FOUND'],
    [
      'update_candidate_profile',
      (ids: Ids) => ({ candidate_id: ids.candidateId, updates: { resume: 'overwritten' } }),
      'CANDIDATE_NOT_FOUND',
    ],
    ['delete_candidate', (ids: Ids) => ({ candidate_id: ids.candidateId, confirm_name: 'Val' }), 'CANDIDATE_NOT_FOUND'],
    [
      'create_target_job',
      (ids: Ids) => ({ candidate_id: ids.candidateId, company: 'X', title: 'Y', description: 'Z' }),
      'CANDIDATE_NOT_FOUND',
    ],
    ['get_target_job', (ids: Ids) => ({ job_id: ids.jobId }), 'JOB_NOT_FOUND'],
    ['list_target_jobs', (ids: Ids) => ({ candidate_id: ids.candidateId }), 'CANDIDATE_NOT_FOUND'],
    [
      'create_interview',
      (ids: Ids) => ({ candidate_id: ids.candidateId, job_id: ids.jobId, interview_type: 'technical' }),
      'CANDIDATE_NOT_FOUND',
    ],
    [
      'record_interview_event',
      (ids: Ids) => ({ interview_id: ids.interviewId, event: { type: 'hint_requested' } }),
      'INTERVIEW_NOT_FOUND',
    ],
    ['finish_interview', (ids: Ids) => ({ interview_id: ids.interviewId, ...evaluation }), 'INTERVIEW_NOT_FOUND'],
    ['list_interviews', (ids: Ids) => ({ candidate_id: ids.candidateId }), 'CANDIDATE_NOT_FOUND'],
    ['list_interview_events', (ids: Ids) => ({ interview_id: ids.interviewId }), 'INTERVIEW_NOT_FOUND'],
    ['get_interview_context', (ids: Ids) => ({ interview_id: ids.interviewId }), 'INTERVIEW_NOT_FOUND'],
    [
      'update_skill_assessment',
      (ids: Ids) => ({ candidate_id: ids.candidateId, skills: [{ ...graphs, score: 1 }] }),
      'CANDIDATE_NOT_FOUND',
    ],
  ])('cannot use %s on what it does not own', async (tool, argsFor, code) => {
    const ids = await populate();
    const before = await counts();
    const error = await fail(tool, argsFor(ids), OTHER_ACCOUNT);
    expect(error.code).toBe(code);
    expect(JSON.stringify(error)).not.toContain('PRIVATE');
    expect(await counts()).toEqual(before);
    expect((await ok('get_candidate_profile', { candidate_id: ids.candidateId })).resume).toBe('PRIVATE');
  });

  it('gets the same answer for an ID it does not own as for one that does not exist', async () => {
    const ids = await populate();
    const foreign = await fail('get_candidate_profile', { candidate_id: ids.candidateId }, OTHER_ACCOUNT);
    const missing = await fail('get_candidate_profile', { candidate_id: 'cand_missing' }, OTHER_ACCOUNT);
    expect(foreign.message.replace(ids.candidateId, 'X')).toBe(missing.message.replace('cand_missing', 'X'));
  });

  it('cannot attach its own interview to a job or candidate of someone else', async () => {
    const theirs = await populate();
    const mine = await populate(OTHER_ACCOUNT);
    expect(
      await fail(
        'create_interview',
        { candidate_id: mine.candidateId, job_id: theirs.jobId, interview_type: 'technical' },
        OTHER_ACCOUNT,
      ),
    ).toMatchObject({ code: 'JOB_NOT_FOUND' });
    expect(
      await fail(
        'update_skill_assessment',
        { candidate_id: mine.candidateId, interview_id: theirs.interviewId, skills: [graphs] },
        OTHER_ACCOUNT,
      ),
    ).toMatchObject({ code: 'INTERVIEW_NOT_FOUND' });
  });

  it('may reuse a candidate name that another account already has', async () => {
    await populate();
    await expect(populate(OTHER_ACCOUNT)).resolves.toBeDefined();
  });
});

type Ids = Awaited<ReturnType<typeof populate>>;

describe('row security, with no account filter in the query at all', () => {
  it('hides every row of other accounts', async () => {
    await populate();
    const seen = await withAccount(getDb(), OTHER_ACCOUNT, async (tx) => {
      const result: Record<string, number> = {};
      for (const table of ['accounts', ...TABLES]) {
        const [row] = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
        result[table] = row?.n ?? 0;
      }
      return result;
    });
    expect(Object.values(seen)).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it('refuses a row written for another account', async () => {
    await populate();
    await populate(OTHER_ACCOUNT);
    await expect(
      withAccount(getDb(), OTHER_ACCOUNT, (tx) =>
        tx.query(
          `INSERT INTO candidates (id, account_id, name, name_key, profile, created_at, updated_at)
           VALUES ('cand_planted', $1, 'Planted', 'planted', '{}', now(), now())`,
          [ACCOUNT],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('changes and deletes nothing in other accounts', async () => {
    await populate();
    const before = await counts();
    await withAccount(getDb(), OTHER_ACCOUNT, async (tx) => {
      await tx.query("UPDATE candidates SET resume = 'overwritten'");
      await tx.query('DELETE FROM candidates');
      await tx.query('DELETE FROM accounts');
    });
    expect(await counts()).toEqual(before);
    expect(await rows('SELECT resume FROM candidates')).toEqual([{ resume: 'PRIVATE' }]);
  });

  it('shows nothing when no account is set', async () => {
    await populate();
    const seen = await getDb().transaction(async (tx) => {
      await tx.query("SELECT set_config('role', 'coach_app', true)");
      return tx.query('SELECT id FROM candidates');
    });
    expect(seen).toEqual([]);
  });

  it('cannot be switched off by the serving role', async () => {
    await populate();
    await expect(
      withAccount(getDb(), OTHER_ACCOUNT, (tx) => tx.exec('ALTER TABLE candidates DISABLE ROW LEVEL SECURITY')),
    ).rejects.toThrow(/must be owner/);
  });
});

describe('the interview record', () => {
  it('cannot be changed or deleted by the serving role, even by its owner', async () => {
    await populate();
    await expect(
      withAccount(getDb(), ACCOUNT, (tx) => tx.query("UPDATE interview_events SET type = 'evaluation'")),
    ).rejects.toThrow(/permission denied/);
    await expect(withAccount(getDb(), ACCOUNT, (tx) => tx.query('DELETE FROM interview_events'))).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      withAccount(getDb(), ACCOUNT, (tx) => tx.query('UPDATE skill_assessment_history SET score = 10')),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withAccount(getDb(), ACCOUNT, (tx) => tx.query('DELETE FROM skill_assessment_history')),
    ).rejects.toThrow(/permission denied/);
  });

  it('cannot be changed by the table owner either', async () => {
    await populate();
    await expect(getDb().query("UPDATE interview_events SET type = 'evaluation'")).rejects.toThrow(/append-only/);
    await expect(getDb().query('UPDATE skill_assessment_history SET score = 10')).rejects.toThrow(/append-only/);
    expect(await rows('SELECT type FROM interview_events')).toEqual([{ type: 'question_asked' }]);
  });
});

describe('deleting an account', () => {
  it('removes everything stored for it and nothing else', async () => {
    await populate();
    await populate(OTHER_ACCOUNT);
    expect(await deleteAccount(getDb(), ACCOUNT)).toBe(true);
    expect(await rows('SELECT id FROM accounts')).toEqual([{ id: OTHER_ACCOUNT }]);
    expect(Object.values(await counts())).toEqual([1, 1, 1, 1, 1, 1]);
    expect(await ok('list_candidates', {}, OTHER_ACCOUNT)).toMatchObject({ candidates: [{ name: 'Val' }] });
  });

  it('leaves the deleted account unusable, and other accounts usable', async () => {
    await populate();
    await deleteAccount(getDb(), ACCOUNT);
    expect(await fail('list_candidates')).toMatchObject({ code: 'ACCOUNT_DELETED', retryable: false });
    expect(await rows('SELECT id FROM accounts')).toEqual([]);
    await expect(ok('list_candidates', {}, OTHER_ACCOUNT)).resolves.toBeDefined();
  });

  it('records nothing about a deleted account but its ID, visible to no other account', async () => {
    await populate();
    await deleteAccount(getDb(), ACCOUNT);
    expect(await rows('SELECT id FROM deleted_accounts')).toEqual([{ id: ACCOUNT }]);
    const seen = await withAccount(getDb(), OTHER_ACCOUNT, (tx) => tx.query('SELECT id FROM deleted_accounts'));
    expect(seen).toEqual([]);
    await expect(
      withAccount(getDb(), ACCOUNT, (tx) => tx.query('DELETE FROM deleted_accounts')),
    ).rejects.toThrow(/permission denied/);
  });

  it('leaves nothing behind when calls and the deletion arrive together', async () => {
    const { candidateId } = await populate();
    const job = { candidate_id: candidateId, company: 'Acme', title: 'SWE', description: 'Build.' };
    await Promise.all([
      call('create_target_job', job),
      deleteAccount(getDb(), ACCOUNT),
      call('create_candidate', { name: 'Sam' }),
      call('create_target_job', job),
    ]);
    expect(await rows('SELECT id FROM accounts')).toEqual([]);
    expect(Object.values(await counts())).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('reports false for an account that has nothing stored', async () => {
    expect(await deleteAccount(getDb(), ACCOUNT)).toBe(false);
  });
});
