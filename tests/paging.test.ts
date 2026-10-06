import { describe, expect, it } from 'vitest';
import { ACCOUNT, advance, fail, ok, rows, useDb } from './helpers.js';

useDb();

async function candidate(name = 'Val'): Promise<string> {
  return (await ok('create_candidate', { name })).candidate_id;
}

async function job(candidateId: string, title = 'SWE'): Promise<string> {
  return (await ok('create_target_job', { candidate_id: candidateId, company: 'Acme', title, description: 'Build.' }))
    .job_id;
}

async function interview(candidateId: string, jobId: string): Promise<string> {
  return (await ok('create_interview', { candidate_id: candidateId, job_id: jobId, interview_type: 'technical' }))
    .interview_id;
}

/** Adds events straight to the table: thousands of tool calls would only slow the test down. */
async function addEvents(interviewId: string, count: number): Promise<void> {
  await rows(
    `INSERT INTO interview_events (account_id, interview_id, type, data, created_at)
     SELECT $1, $2, 'hint_requested', jsonb_build_object('n', n), '2026-01-01T00:00:00Z'
     FROM generate_series(1, $3::int) AS n`,
    [ACCOUNT, interviewId, count],
  );
}

/** Follows next_cursor to the end and returns every page. */
async function pages(tool: string, args: Record<string, unknown>, key: string): Promise<unknown[][]> {
  const all: unknown[][] = [];
  let cursor: string | null | undefined;
  do {
    const page = await ok(tool, cursor ? { ...args, cursor } : args);
    all.push(page[key]);
    cursor = page.next_cursor;
  } while (cursor);
  return all;
}

describe('paging', () => {
  it('returns every candidate exactly once across pages, most recently updated first', async () => {
    const ids: string[] = [];
    for (const name of ['A', 'B', 'C', 'D', 'E']) {
      ids.push(await candidate(name));
      advance();
    }
    const found = await pages('list_candidates', { limit: 2 }, 'candidates');
    expect(found.map((page) => page.length)).toEqual([2, 2, 1]);
    expect(found.flat().map((c) => (c as { candidate_id: string }).candidate_id)).toEqual([...ids].reverse());
  });

  it('keeps a stable order for rows created at the same instant', async () => {
    for (const name of ['A', 'B', 'C', 'D', 'E']) await candidate(name);
    const found = (await pages('list_candidates', { limit: 2 }, 'candidates')).flat();
    expect(new Set(found.map((c) => (c as { candidate_id: string }).candidate_id)).size).toBe(5);
  });

  it('pages through target jobs', async () => {
    const candidateId = await candidate();
    const ids: string[] = [];
    for (const title of ['A', 'B', 'C']) {
      ids.push(await job(candidateId, title));
      advance();
    }
    const found = await pages('list_target_jobs', { candidate_id: candidateId, limit: 2 }, 'jobs');
    expect(found.map((page) => page.length)).toEqual([2, 1]);
    expect(found.flat().map((j) => (j as { job_id: string }).job_id)).toEqual([...ids].reverse());
  });

  it('pages through interviews, keeping the status filter', async () => {
    const candidateId = await candidate();
    const jobId = await job(candidateId);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(await interview(candidateId, jobId));
      advance();
    }
    const found = await pages('list_interviews', { candidate_id: candidateId, status: 'active', limit: 2 }, 'interviews');
    expect(found.map((page) => page.length)).toEqual([2, 1]);
    expect(found.flat().map((i) => (i as { interview_id: string }).interview_id)).toEqual([...ids].reverse());
  });

  it('returns 50 rows by default and reports no next page when the last page is exactly full', async () => {
    const candidateId = await candidate();
    const interviewId = await interview(candidateId, await job(candidateId));
    await addEvents(interviewId, 100);
    const found = await pages('list_interview_events', { interview_id: interviewId }, 'events');
    expect(found.map((page) => page.length)).toEqual([50, 50]);
  });

  it.each([
    [0, 'INVALID_INPUT'],
    [101, 'INVALID_INPUT'],
    [1.5, 'INVALID_FIELD_TYPE'],
    ['10', 'INVALID_FIELD_TYPE'],
  ])('rejects limit %j', async (limit, code) => {
    expect(await fail('list_candidates', { limit })).toMatchObject({ code, field: 'limit' });
  });

  it.each([['not-a-cursor'], ['e30'], [Buffer.from('["list_candidates","yesterday","x"]').toString('base64url')]])(
    'rejects the malformed cursor %j',
    async (cursor) => {
      expect(await fail('list_candidates', { cursor })).toEqual({
        code: 'INVALID_CURSOR',
        message: 'Invalid cursor: pass next_cursor from the previous call unchanged.',
        field: 'cursor',
        retryable: false,
      });
    },
  );

  it('rejects a cursor that came from a different tool', async () => {
    const candidateId = await candidate('A');
    await candidate('B');
    const { next_cursor } = await ok('list_candidates', { limit: 1 });
    expect(next_cursor).toEqual(expect.any(String));
    expect(await fail('list_target_jobs', { candidate_id: candidateId, cursor: next_cursor })).toMatchObject({
      code: 'INVALID_CURSOR',
      field: 'cursor',
    });
  });
});

describe('list_interview_events', () => {
  it('returns the whole record oldest first, in the shape record_interview_event stored', async () => {
    const candidateId = await candidate();
    const interviewId = await interview(candidateId, await job(candidateId));
    await ok('record_interview_event', {
      interview_id: interviewId,
      event: { type: 'question_asked', category: 'graphs', question: 'Shortest path?' },
    });
    advance();
    await ok('record_interview_event', {
      interview_id: interviewId,
      event: { type: 'question_answered', answer: 'BFS.', hints_used: 1 },
    });
    expect(await ok('list_interview_events', { interview_id: interviewId })).toEqual({
      events: [
        {
          event_id: 1,
          type: 'question_asked',
          category: 'graphs',
          question: 'Shortest path?',
          created_at: '2026-01-01T00:00:00.000Z',
        },
        {
          event_id: 2,
          type: 'question_answered',
          answer: 'BFS.',
          hints_used: 1,
          created_at: '2026-01-01T00:00:01.000Z',
        },
      ],
      next_cursor: null,
    });
  });

  it('does not return the events of another interview', async () => {
    const candidateId = await candidate();
    const jobId = await job(candidateId);
    const first = await interview(candidateId, jobId);
    const second = await interview(candidateId, jobId);
    await addEvents(first, 3);
    await addEvents(second, 2);
    const found = (await pages('list_interview_events', { interview_id: second, limit: 1 }, 'events')).flat();
    expect(found.map((e) => (e as { event_id: number }).event_id)).toEqual([4, 5]);
  });

  it('fails for an unknown interview', async () => {
    expect(await fail('list_interview_events', { interview_id: 'int_missing' })).toMatchObject({
      code: 'INTERVIEW_NOT_FOUND',
      field: 'interview_id',
    });
  });
});

describe('get_interview_context on a long interview', () => {
  it('returns all events and says so when they fit', async () => {
    const candidateId = await candidate();
    const interviewId = await interview(candidateId, await job(candidateId));
    await addEvents(interviewId, 200);
    const context = await ok('get_interview_context', { interview_id: interviewId });
    expect(context.previous_events).toHaveLength(200);
    expect(context.events_truncated).toBe(false);
  });

  it('returns the 200 newest events oldest first and reports that earlier ones exist', async () => {
    const candidateId = await candidate();
    const interviewId = await interview(candidateId, await job(candidateId));
    await addEvents(interviewId, 205);
    const context = await ok('get_interview_context', { interview_id: interviewId });
    expect(context.events_truncated).toBe(true);
    expect(context.previous_events).toHaveLength(200);
    expect(context.previous_events[0].event_id).toBe(6);
    expect(context.previous_events[199].event_id).toBe(205);

    const earlier = await ok('list_interview_events', { interview_id: interviewId, limit: 5 });
    expect(earlier.events.map((e: { event_id: number }) => e.event_id)).toEqual([1, 2, 3, 4, 5]);
  });

  it('returns the 200 newest skill changes and reports that earlier ones exist', async () => {
    const candidateId = await candidate();
    const interviewId = await interview(candidateId, await job(candidateId));
    await rows(
      `INSERT INTO skill_assessment_history (account_id, candidate_id, skill, score, confidence, evidence, created_at)
       SELECT $1, $2, 'skill ' || n, 5, 0.5, 'e', '2026-01-01T00:00:00Z' FROM generate_series(1, 201) AS n`,
      [ACCOUNT, candidateId],
    );
    const { skill_history } = await ok('get_interview_context', { interview_id: interviewId });
    expect(skill_history.history_truncated).toBe(true);
    expect(skill_history.history).toHaveLength(200);
    expect(skill_history.history[0].skill).toBe('skill 2');
    expect(skill_history.history[199].skill).toBe('skill 201');
  });
});
