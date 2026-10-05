import { describe, expect, it } from 'vitest';
import { advance, fail, ok, useDb } from './helpers.js';

const getDb = useDb();

function candidate(name = 'Val'): string {
  return ok(getDb(), 'create_candidate', { name }).candidate_id;
}

describe('create_target_job', () => {
  it('creates a job with defaults for optional fields', () => {
    const candidateId = candidate();
    const job = ok(getDb(), 'create_target_job', {
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

  it('stores optional fields and returns them from get_target_job', () => {
    const job = ok(getDb(), 'create_target_job', {
      candidate_id: candidate(),
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
    expect(ok(getDb(), 'get_target_job', { job_id: job.job_id })).toEqual(job);
  });

  it.each([['company'], ['title'], ['description']])('requires %s', (field) => {
    const input: Record<string, unknown> = {
      candidate_id: candidate(),
      company: 'Palantir',
      title: 'SWE Intern',
      description: 'Build data platforms.',
    };
    delete input[field];
    expect(fail(getDb(), 'create_target_job', input)).toMatchObject({ code: 'INVALID_INPUT', field });
  });

  it('rejects a whitespace-only description', () => {
    expect(
      fail(getDb(), 'create_target_job', {
        candidate_id: candidate(),
        company: 'Palantir',
        title: 'SWE Intern',
        description: '   ',
      }),
    ).toMatchObject({ code: 'INVALID_INPUT', field: 'description' });
  });

  it('rejects requirements that are not an array', () => {
    expect(
      fail(getDb(), 'create_target_job', {
        candidate_id: candidate(),
        company: 'Palantir',
        title: 'SWE Intern',
        description: 'Build.',
        requirements: 'Java',
      }),
    ).toMatchObject({ code: 'INVALID_FIELD_TYPE', field: 'requirements' });
  });

  it('fails for an unknown candidate and stores nothing', () => {
    expect(
      fail(getDb(), 'create_target_job', {
        candidate_id: 'cand_missing',
        company: 'Palantir',
        title: 'SWE Intern',
        description: 'Build.',
      }),
    ).toMatchObject({ code: 'CANDIDATE_NOT_FOUND', field: 'candidate_id' });
    expect(getDb().prepare('SELECT count(*) AS n FROM jobs').get()).toEqual({ n: 0 });
  });
});

describe('get_target_job', () => {
  it('fails for an unknown job', () => {
    expect(fail(getDb(), 'get_target_job', { job_id: 'job_missing' })).toEqual({
      code: 'JOB_NOT_FOUND',
      message: "Job 'job_missing' does not exist.",
      field: 'job_id',
      retryable: false,
    });
  });
});

describe('list_target_jobs', () => {
  it("lists only that candidate's jobs as summaries, newest first", () => {
    const mine = candidate('Val');
    const theirs = candidate('Sam');
    const first = ok(getDb(), 'create_target_job', {
      candidate_id: mine,
      company: 'Acme',
      title: 'Backend',
      description: 'SECRET DESCRIPTION',
    });
    advance();
    const second = ok(getDb(), 'create_target_job', {
      candidate_id: mine,
      company: 'Palantir',
      title: 'SWE Intern',
      description: 'Build.',
      location: 'Denver, CO',
    });
    ok(getDb(), 'create_target_job', { candidate_id: theirs, company: 'Other', title: 'X', description: 'Y' });

    expect(ok(getDb(), 'list_target_jobs', { candidate_id: mine })).toEqual({
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
    });
  });

  it('returns an empty list for a candidate with no jobs', () => {
    expect(ok(getDb(), 'list_target_jobs', { candidate_id: candidate() })).toEqual({ jobs: [] });
  });

  it('fails for an unknown candidate', () => {
    expect(fail(getDb(), 'list_target_jobs', { candidate_id: 'cand_missing' })).toMatchObject({
      code: 'CANDIDATE_NOT_FOUND',
    });
  });
});
