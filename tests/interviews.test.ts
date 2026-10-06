import { describe, expect, it } from 'vitest';
import { advance, fail, ok, rows, useDb } from './helpers.js';

useDb();

async function seed(name = 'Val') {
  const candidateId: string = (await ok('create_candidate', { name })).candidate_id;
  const jobId: string = (await ok('create_target_job', {
    candidate_id: candidateId,
    company: 'Palantir',
    title: 'SWE Intern',
    description: 'Build data platforms.',
  })).job_id;
  return { candidateId, jobId };
}

async function interview(candidateId: string, jobId: string, type = 'technical'): Promise<string> {
  return (await ok('create_interview', { candidate_id: candidateId, job_id: jobId, interview_type: type })).interview_id;
}

const evaluation = {
  overall_score: 7.6,
  category_scores: { algorithms: 7, systems: 8, communication: 6, debugging: 9 },
  strengths: ['Systems reasoning'],
  weaknesses: ['Graph algorithms'],
  recommendations: ['Practice graph traversal'],
};

async function eventRows(interviewId: string) {
  const found = await rows<{ id: number; type: string; data: Record<string, unknown>; created_at: Date }>(
    "SELECT id::int AS id, type, data, created_at FROM interview_events WHERE interview_id = $1 ORDER BY id",
    [interviewId],
  );
  return found.map((row) => ({ ...row, created_at: row.created_at.toISOString() }));
}

describe('create_interview', () => {
  it('creates an active interview', async () => {
    const { candidateId, jobId } = await seed();
    expect(
      await ok('create_interview', { candidate_id: candidateId, job_id: jobId, interview_type: 'technical' }),
    ).toEqual({
      interview_id: expect.stringMatching(/^int_[0-9a-f]{16}$/),
      candidate_id: candidateId,
      job_id: jobId,
      interview_type: 'technical',
      status: 'active',
      started_at: '2026-01-01T00:00:00.000Z',
    });
  });

  it.each([['technical'], ['behavioral'], ['system_design']])('accepts interview type %s', async (type) => {
    const { candidateId, jobId } = await seed();
    expect(
      (await ok('create_interview', { candidate_id: candidateId, job_id: jobId, interview_type: type })).interview_type,
    ).toBe(type);
  });

  it('rejects an unknown interview type', async () => {
    const { candidateId, jobId } = await seed();
    expect(
      await fail('create_interview', { candidate_id: candidateId, job_id: jobId, interview_type: 'vibes' }),
    ).toMatchObject({ code: 'INVALID_INTERVIEW_TYPE', field: 'interview_type' });
  });

  it('fails for an unknown candidate', async () => {
    const { jobId } = await seed();
    expect(
      await fail('create_interview', {
        candidate_id: 'cand_missing',
        job_id: jobId,
        interview_type: 'technical',
      }),
    ).toMatchObject({ code: 'CANDIDATE_NOT_FOUND', field: 'candidate_id' });
  });

  it('fails for an unknown job', async () => {
    const { candidateId } = await seed();
    expect(
      await fail('create_interview', {
        candidate_id: candidateId,
        job_id: 'job_missing',
        interview_type: 'technical',
      }),
    ).toMatchObject({ code: 'JOB_NOT_FOUND', field: 'job_id' });
  });

  it("reports another candidate's job exactly like a missing job", async () => {
    const val = await seed('Val');
    const sam = await seed('Sam');
    const foreign = await fail('create_interview', {
      candidate_id: val.candidateId,
      job_id: sam.jobId,
      interview_type: 'technical',
    });
    const missing = await fail('create_interview', {
      candidate_id: val.candidateId,
      job_id: 'job_missing',
      interview_type: 'technical',
    });
    expect(foreign.code).toBe('JOB_NOT_FOUND');
    expect(foreign.message.replace(sam.jobId, 'X')).toBe(missing.message.replace('job_missing', 'X'));
    expect(await rows("SELECT count(*)::int AS n FROM interviews")).toEqual([{ n: 0 }]);
  });
});

describe('record_interview_event', () => {
  it('appends one event and returns its id', async () => {
    const { candidateId, jobId } = await seed();
    const interviewId = await interview(candidateId, jobId);
    const result = await ok('record_interview_event', {
      interview_id: interviewId,
      event: {
        type: 'question_answered',
        category: 'graphs',
        difficulty: 'medium',
        question: 'Find the shortest path.',
        answer: 'Use BFS.',
        hints_used: 1,
        metadata: { language: 'python' },
      },
    });
    expect(result).toEqual({
      event_id: 1,
      interview_id: interviewId,
      type: 'question_answered',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    const found = await eventRows(interviewId);
    expect(found).toHaveLength(1);
    expect(found[0]?.type).toBe('question_answered');
    expect(found[0]?.data).toEqual({
      category: 'graphs',
      difficulty: 'medium',
      question: 'Find the shortest path.',
      answer: 'Use BFS.',
      hints_used: 1,
      metadata: { language: 'python' },
    });
  });

  it('accepts an event with only a type, and keeps events in order', async () => {
    const { candidateId, jobId } = await seed();
    const interviewId = await interview(candidateId, jobId);
    const first = await ok('record_interview_event', { interview_id: interviewId, event: { type: 'question_asked' } });
    const second = await ok('record_interview_event', { interview_id: interviewId, event: { type: 'hint_requested' } });
    expect(second.event_id).toBeGreaterThan(first.event_id);
    expect((await eventRows(interviewId)).map((r) => r.type)).toEqual(['question_asked', 'hint_requested']);
  });

  it('stores answer text exactly as given', async () => {
    const { candidateId, jobId } = await seed();
    const interviewId = await interview(candidateId, jobId);
    const answer = '    def bfs(g):\n\t    return "ok"  # naïve — 日本語 🚀\n\n';
    await ok('record_interview_event', {
      interview_id: interviewId,
      event: { type: 'question_answered', answer },
    });
    expect((await eventRows(interviewId))[0]?.data.answer).toBe(answer);
  });

  it('rejects an unknown event type', async () => {
    const { candidateId, jobId } = await seed();
    expect(
      await fail('record_interview_event', {
        interview_id: await interview(candidateId, jobId),
        event: { type: 'candidate_sneezed' },
      }),
    ).toMatchObject({ code: 'INVALID_EVENT_TYPE', field: 'event.type' });
  });

  it('rejects an event without a type', async () => {
    const { candidateId, jobId } = await seed();
    expect(
      await fail('record_interview_event', {
        interview_id: await interview(candidateId, jobId),
        event: { question: 'Hi?' },
      }),
    ).toMatchObject({ code: 'INVALID_EVENT_TYPE', field: 'event.type' });
  });

  it('rejects fields that are not part of the event schema', async () => {
    const { candidateId, jobId } = await seed();
    const interviewId = await interview(candidateId, jobId);
    expect(
      await fail('record_interview_event', {
        interview_id: interviewId,
        event: { type: 'evaluation', verdict: 'good' },
      }),
    ).toMatchObject({ code: 'INVALID_FIELD', field: 'event.verdict' });
    expect((await eventRows(interviewId))).toEqual([]);
  });

  it.each([
    ['difficulty', 'brutal', 'INVALID_INPUT'],
    ['hints_used', -1, 'INVALID_INPUT'],
    ['hints_used', 1.5, 'INVALID_FIELD_TYPE'],
    ['hints_used', 'two', 'INVALID_FIELD_TYPE'],
    ['metadata', 'notes', 'INVALID_FIELD_TYPE'],
  ])('rejects event.%s = %j', async (field, value, code) => {
    const { candidateId, jobId } = await seed();
    expect(
      await fail('record_interview_event', {
        interview_id: await interview(candidateId, jobId),
        event: { type: 'question_asked', [field]: value },
      }),
    ).toMatchObject({ code, field: `event.${field}` });
  });

  it('rejects an oversized event', async () => {
    const { candidateId, jobId } = await seed();
    expect(
      await fail('record_interview_event', {
        interview_id: await interview(candidateId, jobId),
        event: { type: 'question_answered', answer: 'x'.repeat(50_001) },
      }),
    ).toMatchObject({ code: 'INVALID_INPUT', field: 'event' });
  });

  it('fails for an unknown interview', async () => {
    expect(
      await fail('record_interview_event', { interview_id: 'int_missing', event: { type: 'question_asked' } }),
    ).toEqual({
      code: 'INTERVIEW_NOT_FOUND',
      message: "Interview 'int_missing' does not exist.",
      field: 'interview_id',
      retryable: false,
    });
  });

  it('fails once the interview is completed', async () => {
    const { candidateId, jobId } = await seed();
    const interviewId = await interview(candidateId, jobId);
    await ok('finish_interview', { interview_id: interviewId, ...evaluation });
    expect(
      await fail('record_interview_event', { interview_id: interviewId, event: { type: 'question_asked' } }),
    ).toMatchObject({ code: 'INTERVIEW_NOT_ACTIVE', field: 'interview_id', retryable: false });
    expect((await eventRows(interviewId))).toEqual([]);
  });
});

describe('finish_interview', () => {
  it('completes the interview and stores the evaluation', async () => {
    const { candidateId, jobId } = await seed();
    const interviewId = await interview(candidateId, jobId);
    advance(60_000);
    expect(await ok('finish_interview', { interview_id: interviewId, ...evaluation })).toEqual({
      interview_id: interviewId,
      candidate_id: candidateId,
      job_id: jobId,
      interview_type: 'technical',
      status: 'completed',
      started_at: '2026-01-01T00:00:00.000Z',
      finished_at: '2026-01-01T00:01:00.000Z',
      overall_score: 7.6,
      final_evaluation: {
        category_scores: evaluation.category_scores,
        strengths: evaluation.strengths,
        weaknesses: evaluation.weaknesses,
        recommendations: evaluation.recommendations,
      },
    });
  });

  it('cannot be completed twice, and the first evaluation is kept', async () => {
    const { candidateId, jobId } = await seed();
    const interviewId = await interview(candidateId, jobId);
    await ok('finish_interview', { interview_id: interviewId, ...evaluation });
    expect(
      await fail('finish_interview', { interview_id: interviewId, ...evaluation, overall_score: 1 }),
    ).toMatchObject({ code: 'INTERVIEW_ALREADY_COMPLETED', field: 'interview_id', retryable: false });
    expect(await rows("SELECT overall_score FROM interviews WHERE id = $1", [interviewId])).toEqual([{ overall_score: 7.6 }]);
  });

  it.each([
    [{ overall_score: 10.5 }, 'INVALID_SCORE', 'overall_score'],
    [{ category_scores: { algorithms: -1 } }, 'INVALID_SCORE', 'category_scores.algorithms'],
    [{ strengths: 'many' }, 'INVALID_FIELD_TYPE', 'strengths'],
    [{ recommendations: undefined }, 'INVALID_INPUT', 'recommendations'],
  ])('rejects %j and leaves the interview active', async (override, code, field) => {
    const { candidateId, jobId } = await seed();
    const interviewId = await interview(candidateId, jobId);
    expect(await fail('finish_interview', { interview_id: interviewId, ...evaluation, ...override })).toMatchObject(
      { code, field },
    );
    expect(await rows("SELECT status FROM interviews WHERE id = $1", [interviewId])).toEqual([{ status: 'active' }]);
  });

  it('reports a bad category score as a score error even when the category name ends in _id', async () => {
    const { candidateId, jobId } = await seed();
    expect(
      await fail('finish_interview', {
        interview_id: await interview(candidateId, jobId),
        ...evaluation,
        category_scores: { user_id: 11 },
      }),
    ).toMatchObject({ code: 'INVALID_SCORE', field: 'category_scores.user_id' });
  });

  it('fails for an unknown interview', async () => {
    expect(await fail('finish_interview', { interview_id: 'int_missing', ...evaluation })).toMatchObject({
      code: 'INTERVIEW_NOT_FOUND',
      field: 'interview_id',
    });
  });
});

describe('list_interviews', () => {
  it("lists a candidate's interviews newest first and filters by status", async () => {
    const { candidateId, jobId } = await seed('Val');
    const other = await seed('Sam');
    const first = await interview(candidateId, jobId, 'technical');
    advance();
    const second = await interview(candidateId, jobId, 'behavioral');
    await interview(other.candidateId, other.jobId);
    advance();
    await ok('finish_interview', { interview_id: first, ...evaluation });

    expect(await ok('list_interviews', { candidate_id: candidateId })).toEqual({
      interviews: [
        {
          interview_id: second,
          job_id: jobId,
          interview_type: 'behavioral',
          status: 'active',
          started_at: '2026-01-01T00:00:01.000Z',
          finished_at: null,
          overall_score: null,
        },
        {
          interview_id: first,
          job_id: jobId,
          interview_type: 'technical',
          status: 'completed',
          started_at: '2026-01-01T00:00:00.000Z',
          finished_at: '2026-01-01T00:00:02.000Z',
          overall_score: 7.6,
        },
      ],
      next_cursor: null,
    });
    const active = await ok('list_interviews', { candidate_id: candidateId, status: 'active' });
    expect(active.interviews.map((i: { interview_id: string }) => i.interview_id)).toEqual([second]);
    const completed = await ok('list_interviews', { candidate_id: candidateId, status: 'completed' });
    expect(completed.interviews.map((i: { interview_id: string }) => i.interview_id)).toEqual([first]);
  });

  it('rejects an unknown status', async () => {
    const { candidateId } = await seed();
    expect(await fail('list_interviews', { candidate_id: candidateId, status: 'created' })).toMatchObject({
      code: 'INVALID_INPUT',
      field: 'status',
    });
  });

  it('fails for an unknown candidate', async () => {
    expect(await fail('list_interviews', { candidate_id: 'cand_missing' })).toMatchObject({
      code: 'CANDIDATE_NOT_FOUND',
    });
  });
});
