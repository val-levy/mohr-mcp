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
  const interviewId: string = (await ok('create_interview', {
    candidate_id: candidateId,
    job_id: jobId,
    interview_type: 'technical',
  })).interview_id;
  return { candidateId, jobId, interviewId };
}

async function current(candidateId: string) {
  const found = await rows<{ updated_at: Date }>(
    "SELECT skill, score, confidence, evidence, updated_at FROM skill_assessments WHERE candidate_id = $1 ORDER BY skill",
    [candidateId],
  );
  return found.map((row) => ({ ...row, updated_at: row.updated_at.toISOString() }));
}

async function history(candidateId: string) {
  const found = await rows<{ created_at: Date }>(
    "SELECT skill, score, confidence, evidence, interview_id, created_at FROM skill_assessment_history WHERE candidate_id = $1 ORDER BY id",
    [candidateId],
  );
  return found.map((row) => ({ ...row, created_at: row.created_at.toISOString() }));
}

const graphs = { skill: 'graphs', score: 5, confidence: 0.8, evidence: 'Needed one hint on BFS.' };

describe('update_skill_assessment', () => {
  it('stores the current assessment and a history row', async () => {
    const { candidateId, interviewId } = await seed();
    const result = await ok('update_skill_assessment', {
      candidate_id: candidateId,
      interview_id: interviewId,
      skills: [graphs, { skill: 'systems', score: 8, confidence: 0.6, evidence: 'Clear design reasoning.' }],
    });
    expect(result).toEqual({
      candidate_id: candidateId,
      updated: [
        { ...graphs, updated_at: '2026-01-01T00:00:00.000Z' },
        {
          skill: 'systems',
          score: 8,
          confidence: 0.6,
          evidence: 'Clear design reasoning.',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    expect(await current(candidateId)).toHaveLength(2);
    expect(await history(candidateId)).toEqual([
      { ...graphs, interview_id: interviewId, created_at: '2026-01-01T00:00:00.000Z' },
      {
        skill: 'systems',
        score: 8,
        confidence: 0.6,
        evidence: 'Clear design reasoning.',
        interview_id: interviewId,
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ]);
  });

  it('overwrites the current row and appends to history on a later update', async () => {
    const { candidateId, interviewId } = await seed();
    await ok('update_skill_assessment', { candidate_id: candidateId, skills: [graphs] });
    advance();
    await ok('update_skill_assessment', {
      candidate_id: candidateId,
      interview_id: interviewId,
      skills: [{ skill: 'graphs', score: 6, confidence: 0.9, evidence: 'Solved Dijkstra unaided.' }],
    });
    expect(await current(candidateId)).toEqual([
      {
        skill: 'graphs',
        score: 6,
        confidence: 0.9,
        evidence: 'Solved Dijkstra unaided.',
        updated_at: '2026-01-01T00:00:01.000Z',
      },
    ]);
    expect(await history(candidateId)).toEqual([
      { ...graphs, interview_id: null, created_at: '2026-01-01T00:00:00.000Z' },
      {
        skill: 'graphs',
        score: 6,
        confidence: 0.9,
        evidence: 'Solved Dijkstra unaided.',
        interview_id: interviewId,
        created_at: '2026-01-01T00:00:01.000Z',
      },
    ]);
  });

  it('shows the current assessment in the candidate profile', async () => {
    const { candidateId } = await seed();
    await ok('update_skill_assessment', { candidate_id: candidateId, skills: [graphs] });
    expect((await ok('get_candidate_profile', { candidate_id: candidateId })).skill_assessment).toEqual({
      graphs: {
        score: 5,
        confidence: 0.8,
        evidence: 'Needed one hint on BFS.',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
    });
  });

  it('treats skill names as case- and whitespace-insensitive', async () => {
    const { candidateId } = await seed();
    await ok('update_skill_assessment', {
      candidate_id: candidateId,
      skills: [{ ...graphs, skill: '  Graphs ' }],
    });
    await ok('update_skill_assessment', {
      candidate_id: candidateId,
      skills: [{ ...graphs, skill: 'GRAPHS', score: 7 }],
    });
    expect(await current(candidateId)).toMatchObject([{ skill: 'graphs', score: 7 }]);
  });

  it('rejects the same skill twice in one call', async () => {
    const { candidateId } = await seed();
    expect(
      await fail('update_skill_assessment', {
        candidate_id: candidateId,
        skills: [graphs, { ...graphs, skill: 'Graphs ', score: 9 }],
      }),
    ).toMatchObject({ code: 'INVALID_INPUT', field: 'skills' });
    expect(await current(candidateId)).toEqual([]);
  });

  it('accepts the boundary values 0, 10, 0 and 1', async () => {
    const { candidateId } = await seed();
    await ok('update_skill_assessment', {
      candidate_id: candidateId,
      skills: [
        { skill: 'low', score: 0, confidence: 0, evidence: 'e' },
        { skill: 'high', score: 10, confidence: 1, evidence: 'e' },
      ],
    });
    expect(await current(candidateId)).toMatchObject([
      { skill: 'high', score: 10, confidence: 1 },
      { skill: 'low', score: 0, confidence: 0 },
    ]);
  });

  it.each([
    ['score', 10.01, 'INVALID_SCORE'],
    ['score', -0.01, 'INVALID_SCORE'],
    ['score', '7', 'INVALID_SCORE'],
    ['score', Number.NaN, 'INVALID_SCORE'],
    ['score', Number.POSITIVE_INFINITY, 'INVALID_SCORE'],
    ['confidence', 1.01, 'INVALID_CONFIDENCE'],
    ['confidence', -0.1, 'INVALID_CONFIDENCE'],
    ['confidence', '0.8', 'INVALID_CONFIDENCE'],
    ['evidence', '   ', 'INVALID_INPUT'],
    ['skill', '', 'INVALID_INPUT'],
  ])('rejects %s = %j', async (field, value, code) => {
    const { candidateId } = await seed();
    expect(
      await fail('update_skill_assessment', {
        candidate_id: candidateId,
        skills: [{ ...graphs, [field]: value }],
      }),
    ).toMatchObject({ code, field: `skills.0.${field}` });
  });

  it('writes nothing when one entry in a batch is invalid', async () => {
    const { candidateId } = await seed();
    await ok('update_skill_assessment', { candidate_id: candidateId, skills: [graphs] });
    expect(
      await fail('update_skill_assessment', {
        candidate_id: candidateId,
        skills: [
          { skill: 'graphs', score: 9, confidence: 0.9, evidence: 'e' },
          { skill: 'systems', score: 42, confidence: 0.9, evidence: 'e' },
        ],
      }),
    ).toMatchObject({ code: 'INVALID_SCORE', field: 'skills.1.score' });
    expect(await current(candidateId)).toMatchObject([{ skill: 'graphs', score: 5 }]);
    expect(await history(candidateId)).toHaveLength(1);
  });

  it('rejects an empty skills list', async () => {
    const { candidateId } = await seed();
    expect(await fail('update_skill_assessment', { candidate_id: candidateId, skills: [] })).toMatchObject({
      code: 'INVALID_INPUT',
      field: 'skills',
    });
  });

  it('fails for an unknown candidate', async () => {
    expect(
      await fail('update_skill_assessment', { candidate_id: 'cand_missing', skills: [graphs] }),
    ).toMatchObject({ code: 'CANDIDATE_NOT_FOUND', field: 'candidate_id' });
  });

  it('fails for an unknown interview and writes nothing', async () => {
    const { candidateId } = await seed();
    expect(
      await fail('update_skill_assessment', {
        candidate_id: candidateId,
        interview_id: 'int_missing',
        skills: [graphs],
      }),
    ).toMatchObject({ code: 'INTERVIEW_NOT_FOUND', field: 'interview_id' });
    expect(await current(candidateId)).toEqual([]);
  });

  it('reports another candidate\'s interview as not found', async () => {
    const val = await seed('Val');
    const sam = await seed('Sam');
    expect(
      await fail('update_skill_assessment', {
        candidate_id: val.candidateId,
        interview_id: sam.interviewId,
        skills: [graphs],
      }),
    ).toMatchObject({ code: 'INTERVIEW_NOT_FOUND', field: 'interview_id' });
    expect(await history(val.candidateId)).toEqual([]);
  });

  it('accepts a completed interview as the source', async () => {
    const { candidateId, interviewId } = await seed();
    await ok('finish_interview', {
      interview_id: interviewId,
      overall_score: 7,
      category_scores: {},
      strengths: [],
      weaknesses: [],
      recommendations: [],
    });
    await ok('update_skill_assessment', {
      candidate_id: candidateId,
      interview_id: interviewId,
      skills: [graphs],
    });
    expect(await history(candidateId)).toMatchObject([{ interview_id: interviewId }]);
  });
});

describe('no hidden mutations', () => {
  it('recording events and finishing an interview leave skill data untouched', async () => {
    const { candidateId, interviewId } = await seed();
    await ok('update_skill_assessment', { candidate_id: candidateId, skills: [graphs] });
    const currentBefore = await current(candidateId);
    const historyBefore = await history(candidateId);
    advance();

    await ok('record_interview_event', {
      interview_id: interviewId,
      event: { type: 'question_answered', category: 'graphs', difficulty: 'hard', answer: 'Wrong.', hints_used: 3 },
    });
    await ok('record_interview_event', {
      interview_id: interviewId,
      event: { type: 'evaluation', category: 'graphs', metadata: { score: 1 } },
    });
    await ok('finish_interview', {
      interview_id: interviewId,
      overall_score: 2,
      category_scores: { graphs: 1 },
      strengths: [],
      weaknesses: ['graphs'],
      recommendations: [],
    });

    expect(await current(candidateId)).toEqual(currentBefore);
    expect(await history(candidateId)).toEqual(historyBefore);
  });
});
