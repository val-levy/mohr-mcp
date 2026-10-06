import { describe, expect, it } from 'vitest';
import { LIMITS } from '../src/core/limits.js';
import { ACCOUNT, OTHER_ACCOUNT, fail, ok, rows, useDb } from './helpers.js';

useDb();

const evaluation = {
  overall_score: 7,
  category_scores: { algorithms: 7 },
  strengths: ['s'],
  weaknesses: ['w'],
  recommendations: ['r'],
};

async function seed(accountId = ACCOUNT) {
  const candidateId: string = (await ok('create_candidate', { name: 'Val' }, accountId)).candidate_id;
  const jobId: string = (
    await ok('create_target_job', { candidate_id: candidateId, company: 'Acme', title: 'SWE', description: 'Build.' }, accountId)
  ).job_id;
  return { candidateId, jobId };
}

function createInterview(candidateId: string, jobId: string) {
  return { candidate_id: candidateId, job_id: jobId, interview_type: 'technical' };
}

describe('limits', () => {
  it('allows 10 candidates per account and refuses the 11th', async () => {
    for (let i = 0; i < LIMITS.candidates; i++) await ok('create_candidate', { name: `Candidate ${i}` });
    expect(await fail('create_candidate', { name: 'One too many' })).toEqual({
      code: 'LIMIT_EXCEEDED',
      message: 'Limit reached: at most 10 candidates per account.',
      retryable: false,
    });
    expect(await rows('SELECT count(*)::int AS n FROM candidates')).toEqual([{ n: 10 }]);
  });

  it('counts candidates per account, not across accounts', async () => {
    for (let i = 0; i < LIMITS.candidates; i++) await ok('create_candidate', { name: `Candidate ${i}` });
    await expect(ok('create_candidate', { name: 'Val' }, OTHER_ACCOUNT)).resolves.toBeDefined();
  });

  it('frees a place when a candidate is deleted', async () => {
    for (let i = 0; i < LIMITS.candidates; i++) await ok('create_candidate', { name: `Candidate ${i}` });
    const { candidates } = await ok('list_candidates');
    await ok('delete_candidate', { candidate_id: candidates[0].candidate_id, confirm_name: candidates[0].name });
    await expect(ok('create_candidate', { name: 'Replacement' })).resolves.toBeDefined();
  });

  it('holds when candidates are created at the same moment', async () => {
    for (let i = 0; i < LIMITS.candidates - 1; i++) await ok('create_candidate', { name: `Candidate ${i}` });
    await Promise.all([
      ok('create_candidate', { name: 'First' }).catch(() => undefined),
      ok('create_candidate', { name: 'Second' }).catch(() => undefined),
    ]);
    expect(await rows('SELECT count(*)::int AS n FROM candidates')).toEqual([{ n: 10 }]);
  });

  it('allows 200 target jobs per candidate and refuses the 201st', async () => {
    const { candidateId } = await seed();
    await rows(
      `INSERT INTO jobs (id, account_id, candidate_id, company, title, description, requirements, metadata, created_at)
       SELECT 'job_bulk_' || n, $1, $2, 'Acme', 'SWE', 'Build.', '[]', '{}', '2026-01-01T00:00:00Z'
       FROM generate_series(1, $3::int) AS n`,
      [ACCOUNT, candidateId, LIMITS.jobsPerCandidate - 2],
    );
    const job = { candidate_id: candidateId, company: 'Acme', title: 'SWE', description: 'Build.' };
    await ok('create_target_job', job);
    expect(await fail('create_target_job', job)).toMatchObject({
      code: 'LIMIT_EXCEEDED',
      message: 'Limit reached: at most 200 target jobs per candidate.',
    });
  });

  it('allows 20 active interviews per candidate, and another once one is finished', async () => {
    const { candidateId, jobId } = await seed();
    const ids: string[] = [];
    for (let i = 0; i < LIMITS.activeInterviewsPerCandidate; i++) {
      ids.push((await ok('create_interview', createInterview(candidateId, jobId))).interview_id);
    }
    expect(await fail('create_interview', createInterview(candidateId, jobId))).toMatchObject({
      code: 'LIMIT_EXCEEDED',
      retryable: false,
    });
    await ok('finish_interview', { interview_id: ids[0], ...evaluation });
    await expect(ok('create_interview', createInterview(candidateId, jobId))).resolves.toBeDefined();
  });

  it('allows 5,000 events per interview and refuses the next', async () => {
    const { candidateId, jobId } = await seed();
    const interviewId: string = (await ok('create_interview', createInterview(candidateId, jobId))).interview_id;
    await rows(
      `INSERT INTO interview_events (account_id, interview_id, type, data, created_at)
       SELECT $1, $2, 'hint_requested', '{}', '2026-01-01T00:00:00Z' FROM generate_series(1, $3::int)`,
      [ACCOUNT, interviewId, LIMITS.eventsPerInterview - 1],
    );
    const event = { interview_id: interviewId, event: { type: 'hint_requested' } };
    expect((await ok('record_interview_event', event)).event_id).toBe(5000);
    expect(await fail('record_interview_event', event)).toMatchObject({ code: 'LIMIT_EXCEEDED', retryable: false });
    // A full interview can still be finished and read.
    await expect(ok('finish_interview', { interview_id: interviewId, ...evaluation })).resolves.toBeDefined();
  });
});

describe('delete_candidate', () => {
  it('deletes the candidate with everything recorded for them, and nothing else', async () => {
    const { candidateId, jobId } = await seed();
    const interviewId: string = (await ok('create_interview', createInterview(candidateId, jobId))).interview_id;
    await ok('record_interview_event', { interview_id: interviewId, event: { type: 'hint_requested' } });
    await ok('update_skill_assessment', {
      candidate_id: candidateId,
      interview_id: interviewId,
      skills: [{ skill: 'graphs', score: 5, confidence: 0.8, evidence: 'e' }],
    });
    const keptId: string = (await ok('create_candidate', { name: 'Sam' })).candidate_id;
    await ok('create_target_job', { candidate_id: keptId, company: 'Other', title: 'X', description: 'Y' });

    expect(await ok('delete_candidate', { candidate_id: candidateId, confirm_name: 'Val' })).toEqual({
      candidate_id: candidateId,
      deleted: true,
    });

    expect(await fail('get_candidate_profile', { candidate_id: candidateId })).toMatchObject({
      code: 'CANDIDATE_NOT_FOUND',
    });
    expect(await fail('get_interview_context', { interview_id: interviewId })).toMatchObject({
      code: 'INTERVIEW_NOT_FOUND',
    });
    expect(
      await rows(
        `SELECT (SELECT count(*)::int FROM candidates) AS candidates, (SELECT count(*)::int FROM jobs) AS jobs,
                (SELECT count(*)::int FROM interviews) AS interviews,
                (SELECT count(*)::int FROM interview_events) AS events,
                (SELECT count(*)::int FROM skill_assessments) AS skills,
                (SELECT count(*)::int FROM skill_assessment_history) AS history`,
      ),
    ).toEqual([{ candidates: 1, jobs: 1, interviews: 0, events: 0, skills: 0, history: 0 }]);
  });

  it('accepts the name in any case and with surrounding spaces', async () => {
    const candidateId: string = (await ok('create_candidate', { name: 'Élodie Martin' })).candidate_id;
    await expect(ok('delete_candidate', { candidate_id: candidateId, confirm_name: '  ÉLODIE martin ' })).resolves.toBeDefined();
  });

  it('deletes nothing when the name does not match', async () => {
    const { candidateId } = await seed();
    expect(await fail('delete_candidate', { candidate_id: candidateId, confirm_name: 'Sam' })).toEqual({
      code: 'INVALID_INPUT',
      message: "confirm_name does not match the candidate's name. Nothing was deleted.",
      field: 'confirm_name',
      retryable: false,
    });
    expect(await rows('SELECT count(*)::int AS n FROM jobs')).toEqual([{ n: 1 }]);
  });

  it('requires the name', async () => {
    const { candidateId } = await seed();
    expect(await fail('delete_candidate', { candidate_id: candidateId })).toMatchObject({
      code: 'INVALID_INPUT',
      field: 'confirm_name',
    });
  });

  it('lets the name be used again afterwards', async () => {
    const { candidateId } = await seed();
    await ok('delete_candidate', { candidate_id: candidateId, confirm_name: 'Val' });
    await expect(ok('create_candidate', { name: 'Val' })).resolves.toBeDefined();
  });

  it('fails for an unknown candidate', async () => {
    expect(await fail('delete_candidate', { candidate_id: 'cand_missing', confirm_name: 'Val' })).toMatchObject({
      code: 'CANDIDATE_NOT_FOUND',
      field: 'candidate_id',
    });
  });
});
