import { describe, expect, it } from 'vitest';
import { tools } from '../src/tools/index.js';
import { advance, fail, ok, useDb } from './helpers.js';

const getDb = useDb();

function seed() {
  const candidateId: string = ok(getDb(), 'create_candidate', { name: 'Val', resume: 'Resume', skills: ['Go'] })
    .candidate_id;
  const jobId: string = ok(getDb(), 'create_target_job', {
    candidate_id: candidateId,
    company: 'Palantir',
    title: 'SWE Intern',
    description: 'Build data platforms.',
  }).job_id;
  return { candidateId, jobId };
}

function interview(candidateId: string, jobId: string): string {
  return ok(getDb(), 'create_interview', { candidate_id: candidateId, job_id: jobId, interview_type: 'technical' })
    .interview_id;
}

function finish(interviewId: string, overall: number): void {
  ok(getDb(), 'finish_interview', {
    interview_id: interviewId,
    overall_score: overall,
    category_scores: { algorithms: overall },
    strengths: ['s'],
    weaknesses: ['w'],
    recommendations: ['r'],
  });
}

describe('tool registry', () => {
  it('exposes exactly the 13 tools of the spec', () => {
    expect(tools.map((t) => t.name).sort()).toEqual([
      'create_candidate',
      'create_interview',
      'create_target_job',
      'finish_interview',
      'get_candidate_profile',
      'get_interview_context',
      'get_target_job',
      'list_candidates',
      'list_interviews',
      'list_target_jobs',
      'record_interview_event',
      'update_candidate_profile',
      'update_skill_assessment',
    ]);
  });
});

describe('get_interview_context', () => {
  it('returns candidate, job, interview, events and skill history for an active interview', () => {
    const { candidateId, jobId } = seed();
    const interviewId = interview(candidateId, jobId);
    const answer = '    def bfs(g):\n\t    return "ok"  # naïve — 日本語 🚀\n\n';
    ok(getDb(), 'record_interview_event', {
      interview_id: interviewId,
      event: { type: 'question_asked', category: 'graphs', difficulty: 'medium', question: 'Shortest path?' },
    });
    advance();
    ok(getDb(), 'record_interview_event', {
      interview_id: interviewId,
      event: { type: 'question_answered', category: 'graphs', answer, hints_used: 1 },
    });
    ok(getDb(), 'update_skill_assessment', {
      candidate_id: candidateId,
      interview_id: interviewId,
      skills: [{ skill: 'graphs', score: 5, confidence: 0.8, evidence: 'One hint.' }],
    });

    const context = ok(getDb(), 'get_interview_context', { interview_id: interviewId });

    expect(Object.keys(context).sort()).toEqual([
      'candidate',
      'interview',
      'job',
      'previous_events',
      'recent_performance',
      'skill_history',
    ]);
    expect(context.candidate).toEqual(ok(getDb(), 'get_candidate_profile', { candidate_id: candidateId }));
    expect(context.job).toEqual(ok(getDb(), 'get_target_job', { job_id: jobId }));
    expect(context.interview).toEqual({
      interview_id: interviewId,
      candidate_id: candidateId,
      job_id: jobId,
      interview_type: 'technical',
      status: 'active',
      started_at: '2026-01-01T00:00:00.000Z',
      finished_at: null,
      overall_score: null,
      final_evaluation: null,
    });
    expect(context.previous_events).toEqual([
      {
        event_id: 1,
        type: 'question_asked',
        category: 'graphs',
        difficulty: 'medium',
        question: 'Shortest path?',
        created_at: '2026-01-01T00:00:00.000Z',
      },
      {
        event_id: 2,
        type: 'question_answered',
        category: 'graphs',
        answer,
        hints_used: 1,
        created_at: '2026-01-01T00:00:01.000Z',
      },
    ]);
    expect(context.skill_history).toEqual({
      current: [
        {
          skill: 'graphs',
          score: 5,
          confidence: 0.8,
          evidence: 'One hint.',
          updated_at: '2026-01-01T00:00:01.000Z',
        },
      ],
      history: [
        {
          skill: 'graphs',
          score: 5,
          confidence: 0.8,
          evidence: 'One hint.',
          interview_id: interviewId,
          created_at: '2026-01-01T00:00:01.000Z',
        },
      ],
    });
    expect(context.recent_performance).toEqual([]);
  });

  it('only includes events from this interview', () => {
    const { candidateId, jobId } = seed();
    const mine = interview(candidateId, jobId);
    const other = interview(candidateId, jobId);
    ok(getDb(), 'record_interview_event', { interview_id: other, event: { type: 'hint_given' } });
    ok(getDb(), 'record_interview_event', { interview_id: mine, event: { type: 'question_asked' } });
    const context = ok(getDb(), 'get_interview_context', { interview_id: mine });
    expect(context.previous_events.map((e: { type: string }) => e.type)).toEqual(['question_asked']);
  });

  it('returns the five most recently finished other interviews, newest first', () => {
    const { candidateId, jobId } = seed();
    const finished: string[] = [];
    for (let i = 1; i <= 6; i++) {
      const interviewId = interview(candidateId, jobId);
      advance();
      finish(interviewId, i);
      finished.push(interviewId);
    }
    const stillActive = interview(candidateId, jobId);
    const current = interview(candidateId, jobId);

    const context = ok(getDb(), 'get_interview_context', { interview_id: current });
    const ids = context.recent_performance.map((p: { interview_id: string }) => p.interview_id);
    expect(ids).toEqual([finished[5], finished[4], finished[3], finished[2], finished[1]]);
    expect(ids).not.toContain(stillActive);
    expect(context.recent_performance[0]).toEqual({
      interview_id: finished[5],
      job_id: jobId,
      interview_type: 'technical',
      finished_at: '2026-01-01T00:00:06.000Z',
      overall_score: 6,
      final_evaluation: {
        category_scores: { algorithms: 6 },
        strengths: ['s'],
        weaknesses: ['w'],
        recommendations: ['r'],
      },
    });
  });

  it('works for a completed interview and excludes it from recent_performance', () => {
    const { candidateId, jobId } = seed();
    const interviewId = interview(candidateId, jobId);
    finish(interviewId, 8);
    const context = ok(getDb(), 'get_interview_context', { interview_id: interviewId });
    expect(context.interview).toMatchObject({ status: 'completed', overall_score: 8 });
    expect(context.interview.final_evaluation).toMatchObject({ strengths: ['s'] });
    expect(context.recent_performance).toEqual([]);
  });

  it('does not include another candidate\'s interviews or skills', () => {
    const val = seed();
    const samId: string = ok(getDb(), 'create_candidate', { name: 'Sam' }).candidate_id;
    const samJob: string = ok(getDb(), 'create_target_job', {
      candidate_id: samId,
      company: 'Other',
      title: 'X',
      description: 'Y',
    }).job_id;
    finish(interview(samId, samJob), 3);
    ok(getDb(), 'update_skill_assessment', {
      candidate_id: samId,
      skills: [{ skill: 'trees', score: 2, confidence: 0.5, evidence: 'e' }],
    });

    const context = ok(getDb(), 'get_interview_context', {
      interview_id: interview(val.candidateId, val.jobId),
    });
    expect(context.recent_performance).toEqual([]);
    expect(context.skill_history).toEqual({ current: [], history: [] });
  });

  it('writes nothing', () => {
    const { candidateId, jobId } = seed();
    const interviewId = interview(candidateId, jobId);
    const before = getDb().prepare('SELECT total_changes() AS n').get();
    ok(getDb(), 'get_interview_context', { interview_id: interviewId });
    expect(getDb().prepare('SELECT total_changes() AS n').get()).toEqual(before);
  });

  it('fails for an unknown interview', () => {
    expect(fail(getDb(), 'get_interview_context', { interview_id: 'int_missing' })).toMatchObject({
      code: 'INTERVIEW_NOT_FOUND',
      field: 'interview_id',
    });
  });
});
