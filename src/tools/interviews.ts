import { type Db, newId, now, tx } from '../db.js';
import { CoachError } from '../errors.js';
import {
  createInterviewInput,
  finishInterviewInput,
  getInterviewContextInput,
  listInterviewsInput,
  recordInterviewEventInput,
} from '../schemas.js';
import { type Tool, defineTool } from '../tool.js';
import { loadProfile, requireCandidate } from './candidates.js';
import { loadJob } from './jobs.js';

interface InterviewRow {
  id: string;
  candidate_id: string;
  job_id: string;
  type: string;
  status: 'active' | 'completed';
  started_at: string;
  finished_at: string | null;
  overall_score: number | null;
  final_evaluation: string | null;
}

function findInterview(db: Db, interviewId: string): InterviewRow {
  const row = db.prepare('SELECT * FROM interviews WHERE id = ?').get(interviewId) as InterviewRow | undefined;
  if (!row) {
    throw new CoachError('INTERVIEW_NOT_FOUND', `Interview '${interviewId}' does not exist.`, 'interview_id');
  }
  return row;
}

export function loadInterview(db: Db, interviewId: string) {
  const row = findInterview(db, interviewId);
  return {
    interview_id: row.id,
    candidate_id: row.candidate_id,
    job_id: row.job_id,
    interview_type: row.type,
    status: row.status,
    started_at: row.started_at,
    finished_at: row.finished_at,
    overall_score: row.overall_score,
    final_evaluation: row.final_evaluation === null ? null : (JSON.parse(row.final_evaluation) as unknown),
  };
}

const createInterview = defineTool({
  name: 'create_interview',
  description:
    'Start a persistent interview session for a candidate and one of their target jobs. The interview is ' +
    'active immediately. The server creates no plan and no questions; you decide what the interview contains.',
  schema: createInterviewInput,
  handler: (db, { candidate_id, job_id, interview_type }) =>
    tx(db, () => {
      requireCandidate(db, candidate_id);
      const job = db.prepare('SELECT candidate_id FROM jobs WHERE id = ?').get(job_id) as
        | { candidate_id: string }
        | undefined;
      // A job owned by someone else is reported exactly like a missing one.
      if (!job || job.candidate_id !== candidate_id) {
        throw new CoachError('JOB_NOT_FOUND', `Job '${job_id}' does not exist for this candidate.`, 'job_id');
      }
      const interviewId = newId('int');
      const startedAt = now();
      db.prepare(
        "INSERT INTO interviews (id, candidate_id, job_id, type, status, started_at) VALUES (?, ?, ?, ?, 'active', ?)",
      ).run(interviewId, candidate_id, job_id, interview_type, startedAt);
      return {
        interview_id: interviewId,
        candidate_id,
        job_id,
        interview_type,
        status: 'active',
        started_at: startedAt,
      };
    }),
});

const recordInterviewEvent = defineTool({
  name: 'record_interview_event',
  description:
    'Append one event to the immutable record of an active interview: a question asked or answered, a hint, ' +
    'a follow-up, an evaluation note, or a completed topic. Put anything without a dedicated field in ' +
    'metadata. This only records what happened; it never changes skill scores.',
  schema: recordInterviewEventInput,
  handler: (db, { interview_id, event }) =>
    tx(db, () => {
      const interview = findInterview(db, interview_id);
      if (interview.status !== 'active') {
        throw new CoachError(
          'INTERVIEW_NOT_ACTIVE',
          `Interview '${interview_id}' is ${interview.status}; events can only be recorded on an active interview.`,
          'interview_id',
        );
      }
      const { type, ...data } = event;
      const createdAt = now();
      const info = db
        .prepare('INSERT INTO interview_events (interview_id, type, data, created_at) VALUES (?, ?, ?, ?)')
        .run(interview_id, type, JSON.stringify(data), createdAt);
      return { event_id: Number(info.lastInsertRowid), interview_id, type, created_at: createdAt };
    }),
});

const finishInterview = defineTool({
  name: 'finish_interview',
  description:
    'Close an active interview and store its final evaluation. This covers this one interview only and ' +
    "never changes the candidate's long-term skill scores; call update_skill_assessment first for those. " +
    'An interview can be finished only once.',
  schema: finishInterviewInput,
  handler: (db, { interview_id, overall_score, ...evaluation }) =>
    tx(db, () => {
      const interview = findInterview(db, interview_id);
      if (interview.status === 'completed') {
        throw new CoachError(
          'INTERVIEW_ALREADY_COMPLETED',
          `Interview '${interview_id}' is already completed.`,
          'interview_id',
        );
      }
      db.prepare(
        "UPDATE interviews SET status = 'completed', finished_at = ?, overall_score = ?, final_evaluation = ? WHERE id = ?",
      ).run(now(), overall_score, JSON.stringify(evaluation), interview_id);
      return loadInterview(db, interview_id);
    }),
});

const listInterviews = defineTool({
  name: 'list_interviews',
  description:
    "List a candidate's interviews, newest first, optionally only active or only completed ones. Use " +
    "status 'active' to find an unfinished interview to resume.",
  schema: listInterviewsInput,
  handler: (db, { candidate_id, status }) => {
    requireCandidate(db, candidate_id);
    const filter = status ?? null;
    return {
      interviews: db
        .prepare(
          `SELECT id AS interview_id, job_id, type AS interview_type, status, started_at, finished_at, overall_score
           FROM interviews
           WHERE candidate_id = ? AND (? IS NULL OR status = ?)
           ORDER BY started_at DESC, rowid DESC`,
        )
        .all(candidate_id, filter, filter),
    };
  },
});

interface EventRow {
  id: number;
  type: string;
  data: string;
  created_at: string;
}

interface PerformanceRow {
  interview_id: string;
  job_id: string;
  interview_type: string;
  finished_at: string;
  overall_score: number;
  final_evaluation: string;
}

const RECENT_INTERVIEWS = 5;

const getInterviewContext = defineTool({
  name: 'get_interview_context',
  description:
    'Retrieve everything needed to continue or review an interview in one call: the candidate profile, the ' +
    "target job, the interview, every event recorded so far (oldest first), the candidate's current and " +
    'historical skill assessments, and the final evaluations of their five most recently finished other ' +
    'interviews. This is the main read tool during an interview. It returns stored data only; it computes ' +
    'no summaries.',
  schema: getInterviewContextInput,
  handler: (db, { interview_id }) => {
    const interview = loadInterview(db, interview_id);
    const events = db
      .prepare('SELECT id, type, data, created_at FROM interview_events WHERE interview_id = ? ORDER BY id')
      .all(interview_id) as EventRow[];
    const recent = db
      .prepare(
        `SELECT id AS interview_id, job_id, type AS interview_type, finished_at, overall_score, final_evaluation
         FROM interviews
         WHERE candidate_id = ? AND status = 'completed' AND id <> ?
         ORDER BY finished_at DESC, rowid DESC
         LIMIT ?`,
      )
      .all(interview.candidate_id, interview_id, RECENT_INTERVIEWS) as PerformanceRow[];
    return {
      candidate: loadProfile(db, interview.candidate_id),
      job: loadJob(db, interview.job_id),
      interview,
      previous_events: events.map((row) => ({
        event_id: row.id,
        type: row.type,
        ...(JSON.parse(row.data) as Record<string, unknown>),
        created_at: row.created_at,
      })),
      skill_history: {
        current: db
          .prepare(
            'SELECT skill, score, confidence, evidence, updated_at FROM skill_assessments WHERE candidate_id = ? ORDER BY skill',
          )
          .all(interview.candidate_id),
        history: db
          .prepare(
            'SELECT skill, score, confidence, evidence, interview_id, created_at FROM skill_assessment_history WHERE candidate_id = ? ORDER BY id',
          )
          .all(interview.candidate_id),
      },
      recent_performance: recent.map((row) => ({
        ...row,
        final_evaluation: JSON.parse(row.final_evaluation) as unknown,
      })),
    };
  },
});

export const interviewTools: Tool[] = [
  createInterview,
  recordInterviewEvent,
  getInterviewContext,
  finishInterview,
  listInterviews,
];
