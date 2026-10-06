import { describe, expect, it } from 'vitest';
import { advance, fail, ok, rows, useDb } from './helpers.js';

useDb();

async function candidate(name = 'Val'): Promise<string> {
  return (await ok('create_candidate', { name })).candidate_id;
}

describe('create_target_job', () => {
  it('creates a job with defaults for optional fields', async () => {
    const candidateId = await candidate();
    const job = await ok('create_target_job', {
      candidate_id: candidateId,
      company: 'Palantir',
      title: 'Software Engineer Intern',
      description: 'Build data platforms.',
    });
    expect(job).toEqual({
      job_id: expect.stringMatching(/^job_[0-9a-f]{16}$/),
      candidate_id: candidateId,
      company: 'Palantir',
      title: 'Software Engineer Intern',
      description: 'Build data platforms.',
      requirements: [],
      location: null,
      metadata: {},
      created_at: '2026-01-01T00:00:00.000Z',
    });
  });

  it('stores optional fields and returns them from get_target_job', async () => {
    const job = await ok('create_target_job', {
      candidate_id: await candidate(),
      company: 'Palantir',
      title: 'SWE Intern',
      description: 'Build data platforms.',
      location: 'Denver, CO',
      requirements: ['Java', 'distributed systems'],
      metadata: { source: 'careers page', rounds: 3 },
    });
    expect(job).toMatchObject({
      location: 'Denver, CO',
      requirements: ['Java', 'distributed systems'],
      metadata: { source: 'careers page', rounds: 3 },
    });
    expect(await ok('get_target_job', { job_id: job.job_id })).toEqual(job);
  });

  it.each([['company'], ['title'], ['description']])('requires %s', async (field) => {
    const input: Record<string, unknown> = {
      candidate_id: await candidate(),
      company: 'Palantir',
      title: 'SWE Intern',
      description: 'Build data platforms.',
    };
    delete input[field];
    expect(await fail('create_target_job', input)).toMatchObject({ code: 'INVALID_INPUT', field });
  });

  it('rejects a whitespace-only description', async () => {
    expect(
      await fail('create_target_job', {
        candidate_id: await candidate(),
        company: 'Palantir',
        title: 'SWE Intern',
        description: '   ',
      }),
    ).toMatchObject({ code: 'INVALID_INPUT', field: 'description' });
  });

  it('rejects requirements that are not an array', async () => {
    expect(
      await fail('create_target_job', {
        candidate_id: await candidate(),
        company: 'Palantir',
        title: 'SWE Intern',
        description: 'Build.',
        requirements: 'Java',
      }),
    ).toMatchObject({ code: 'INVALID_FIELD_TYPE', field: 'requirements' });
  });

  it('fails for an unknown candidate and stores nothing', async () => {
    expect(
      await fail('create_target_job', {
        candidate_id: 'cand_missing',
        company: 'Palantir',
        title: 'SWE Intern',
        description: 'Build.',
      }),
    ).toMatchObject({ code: 'CANDIDATE_NOT_FOUND', field: 'candidate_id' });
    expect(await rows("SELECT count(*)::int AS n FROM jobs")).toEqual([{ n: 0 }]);
  });
});

describe('get_target_job', () => {
  it('fails for an unknown job', async () => {
    expect(await fail('get_target_job', { job_id: 'job_missing' })).toEqual({
      code: 'JOB_NOT_FOUND',
      message: "Job 'job_missing' does not exist.",
      field: 'job_id',
      retryable: false,
    });
  });
});

describe('list_target_jobs', () => {
  it("lists only that candidate's jobs as summaries, newest first", async () => {
    const mine = await candidate('Val');
    const theirs = await candidate('Sam');
    const first = await ok('create_target_job', {
      candidate_id: mine,
      company: 'Acme',
      title: 'Backend',
      description: 'SECRET DESCRIPTION',
    });
    advance();
    const second = await ok('create_target_job', {
      candidate_id: mine,
      company: 'Palantir',
      title: 'SWE Intern',
      description: 'Build.',
      location: 'Denver, CO',
    });
    await ok('create_target_job', { candidate_id: theirs, company: 'Other', title: 'X', description: 'Y' });

    expect(await ok('list_target_jobs', { candidate_id: mine })).toEqual({
      jobs: [
        {
          job_id: second.job_id,
          company: 'Palantir',
          title: 'SWE Intern',
          location: 'Denver, CO',
          created_at: '2026-01-01T00:00:01.000Z',
        },
        {
          job_id: first.job_id,
          company: 'Acme',
          title: 'Backend',
          location: null,
          created_at: '2026-01-01T00:00:00.000Z',
        },
      ],
      next_cursor: null,
    });
  });

  it('returns an empty list for a candidate with no jobs', async () => {
    expect(await ok('list_target_jobs', { candidate_id: await candidate() })).toEqual({ jobs: [], next_cursor: null });
  });

  it('fails for an unknown candidate', async () => {
    expect(await fail('list_target_jobs', { candidate_id: 'cand_missing' })).toMatchObject({
      code: 'CANDIDATE_NOT_FOUND',
    });
  });
});
