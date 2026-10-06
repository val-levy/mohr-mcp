import { loadProfile, loadSkills, lockCandidate, requireCandidate } from '../candidates/tools.js';
import { type Ctx, type Tool, defineTool } from '../core/envelope.js';
import { CoachError } from '../core/errors.js';
import { LIMITS, assertWithinLimit } from '../core/limits.js';
import { decodeCursor, idKey, paginate, timeKey } from '../core/pagination.js';
import { loadJob } from '../jobs/tools.js';
import { iso, newId, now } from '../storage/database.js';
import {
  createInterviewInput,
  finishInterviewInput,
  getInterviewContextInput,
  listInterviewEventsInput,
  listInterviewsInput,
  recordInterviewEventInput,
} from './schemas.js';

interface InterviewRow {
  id: string;
  candidate_id: string;
  job_id: string;
  type: string;
  status: 'active' | 'completed';
  started_at: Date;
  finished_at: Date | null;
  overall_score: number | null;
  final_evaluation: unknown;
}

// An interview in another account is reported exactly like one that does not exist.
async function findInterview(ctx: Ctx, interviewId: string, lock = false): Promise<InterviewRow> {
  const [row] = await ctx.db.query<InterviewRow>(
    `SELECT * FROM interviews WHERE id = $1 AND account_id = $2${lock ? ' FOR UPDATE' : ''}`,
    [interviewId, ctx.accountId],
  );
  if (!row) {
    throw new CoachError('INTERVIEW_NOT_FOUND', `Interview '${interviewId}' does not exist.`, 'interview_id');
  }
  return row;
}

function toInterview(row: InterviewRow) {
  return {
    interview_id: row.id,
    candidate_id: row.candidate_id,
    job_id: row.job_id,
    interview_type: row.type,
    status: row.status,
    started_at: iso(row.started_at),
    finished_at: iso(row.finished_at),
    overall_score: row.overall_score,
    final_evaluation: row.final_evaluation,
  };
}

const createInterview = defineTool({
  name: 'create_interview',
  description:
    'Start a persistent interview session for a candidate and one of their target jobs. The interview is ' +
    'active immediately. The server creates no plan and no questions; you decide what the interview contains.',
  schema: createInterviewInput,
  handler: async (ctx, { candidate_id, job_id, interview_type }) => {
    await lockCandidate(ctx, candidate_id);
    const [job] = await ctx.db.query<{ candidate_id: string }>(
      'SELECT candidate_id FROM jobs WHERE id = $1 AND account_id = $2',
      [job_id, ctx.accountId],
    );
    // A job owned by someone else is reported exactly like a missing one.
    if (!job || job.candidate_id !== candidate_id) {
      throw new CoachError('JOB_NOT_FOUND', `Job '${job_id}' does not exist for this candidate.`, 'job_id');
    }
    const [{ count } = { count: 0 }] = await ctx.db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM interviews
       WHERE candidate_id = $1 AND account_id = $2 AND status = 'active'`,
      [candidate_id, ctx.accountId],
    );
    assertWithinLimit(count, LIMITS.activeInterviewsPerCandidate, 'active interviews per candidate; finish one first');
    const interviewId = newId('int');
    const startedAt = now();
    await ctx.db.query(
      `INSERT INTO interviews (id, account_id, candidate_id, job_id, type, status, started_at)
       VALUES ($1, $2, $3, $4, $5, 'active', $6)`,
      [interviewId, ctx.accountId, candidate_id, job_id, interview_type, startedAt],
    );
    return { interview_id: interviewId, candidate_id, job_id, interview_type, status: 'active', started_at: startedAt };
  },
});

const recordInterviewEvent = defineTool({
  name: 'record_interview_event',
  description:
    'Append one event to the immutable record of an active interview: a question asked or answered, a hint, ' +
    'a follow-up, an evaluation note, or a completed topic. Put anything without a dedicated field in ' +
    'metadata. This only records what happened; it never changes skill scores.',
  schema: recordInterviewEventInput,
  handler: async (ctx, { interview_id, event }) => {
    const interview = await findInterview(ctx, interview_id, true);
    if (interview.status !== 'active') {
      throw new CoachError(
        'INTERVIEW_NOT_ACTIVE',
        `Interview '${interview_id}' is ${interview.status}; events can only be recorded on an active interview.`,
        'interview_id',
      );
    }
    const [{ count } = { count: 0 }] = await ctx.db.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM interview_events WHERE interview_id = $1 AND account_id = $2',
      [interview_id, ctx.accountId],
    );
    assertWithinLimit(count, LIMITS.eventsPerInterview, 'events per interview; finish it and start a new one');
    const { type, ...data } = event;
    const createdAt = now();
    const [inserted] = await ctx.db.query<{ id: string }>(
      `INSERT INTO interview_events (account_id, interview_id, type, data, created_at)
       VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING id`,
      [ctx.accountId, interview_id, type, JSON.stringify(data), createdAt],
    );
    return { event_id: Number(inserted?.id), interview_id, type, created_at: createdAt };
  },
});

const finishInterview = defineTool({
  name: 'finish_interview',
  description:
    'Close an active interview and store its final evaluation. This covers this one interview only and ' +
    "never changes the candidate's long-term skill scores; call update_skill_assessment first for those. " +
    'An interview can be finished only once.',
  schema: finishInterviewInput,
  handler: async (ctx, { interview_id, overall_score, ...evaluation }) => {
    const interview = await findInterview(ctx, interview_id, true);
    if (interview.status === 'completed') {
      throw new CoachError(
        'INTERVIEW_ALREADY_COMPLETED',
        `Interview '${interview_id}' is already completed.`,
        'interview_id',
      );
    }
    await ctx.db.query(
      `UPDATE interviews SET status = 'completed', finished_at = $1, overall_score = $2, final_evaluation = $3::jsonb
       WHERE id = $4 AND account_id = $5`,
      [now(), overall_score, JSON.stringify(evaluation), interview_id, ctx.accountId],
    );
    return toInterview(await findInterview(ctx, interview_id));
  },
});

interface InterviewSummaryRow {
  interview_id: string;
  job_id: string;
  interview_type: string;
  status: string;
  started_at: Date;
  finished_at: Date | null;
  overall_score: number | null;
}

const listInterviews = defineTool({
  name: 'list_interviews',
  description:
    "List a candidate's interviews, newest first, optionally only active or only completed ones. Use " +
    "status 'active' to find an unfinished interview to resume. Returns up to limit interviews (default " +
    '50); when next_cursor is not null, pass it as cursor to get the next page.',
  schema: listInterviewsInput,
  handler: async (ctx, { candidate_id, status, limit, cursor }) => {
    const after = decodeCursor('list_interviews', cursor, timeKey);
    await requireCandidate(ctx, candidate_id);
    const rows = await ctx.db.query<InterviewSummaryRow>(
      `SELECT id AS interview_id, job_id, type AS interview_type, status, started_at, finished_at, overall_score
       FROM interviews
       WHERE candidate_id = $1 AND account_id = $2
         AND ($3::text IS NULL OR status = $3::text)
         AND ($4::timestamptz IS NULL OR (started_at, id) < ($4::timestamptz, $5))
       ORDER BY started_at DESC, id DESC
       LIMIT $6`,
      [candidate_id, ctx.accountId, status ?? null, after?.[0] ?? null, after?.[1] ?? null, limit + 1],
    );
    const interviews = rows.map((row) => ({
      ...row,
      started_at: iso(row.started_at),
      finished_at: iso(row.finished_at),
    }));
    const { items, next_cursor } = paginate('list_interviews', interviews, limit, (row) => [
      row.started_at,
      row.interview_id,
    ]);
    return { interviews: items, next_cursor };
  },
});

interface EventRow {
  id: string;
  type: string;
  data: Record<string, unknown>;
  created_at: Date;
}

function toEvent(row: EventRow) {
  return { event_id: Number(row.id), type: row.type, ...row.data, created_at: iso(row.created_at) };
}

const listInterviewEvents = defineTool({
  name: 'list_interview_events',
  description:
    'Page through the complete record of one interview, oldest event first. get_interview_context already ' +
    'returns the most recent events; use this only when it reports events_truncated and you need the ' +
    'earlier ones. Returns up to limit events (default 50); when next_cursor is not null, pass it as cursor ' +
    'to get the next page.',
  schema: listInterviewEventsInput,
  handler: async (ctx, { interview_id, limit, cursor }) => {
    const after = decodeCursor('list_interview_events', cursor, idKey);
    await findInterview(ctx, interview_id);
    const rows = await ctx.db.query<EventRow>(
      `SELECT id, type, data, created_at FROM interview_events
       WHERE interview_id = $1 AND account_id = $2 AND id > $3
       ORDER BY id
       LIMIT $4`,
      [interview_id, ctx.accountId, after?.[0] ?? 0, limit + 1],
    );
    const { items, next_cursor } = paginate('list_interview_events', rows.map(toEvent), limit, (event) => [
      event.event_id,
    ]);
    return { events: items, next_cursor };
  },
});

interface HistoryRow {
  skill: string;
  score: number;
  confidence: number;
  evidence: string;
  interview_id: string | null;
  created_at: Date;
}

interface PerformanceRow {
  interview_id: string;
  job_id: string;
  interview_type: string;
  finished_at: Date;
  overall_score: number;
  final_evaluation: unknown;
}

const RECENT_INTERVIEWS = 5;
/** How many of the newest events and skill-history entries get_interview_context returns. */
export const CONTEXT_WINDOW = 200;

// Rows arrive newest first, one more than the window; returns the window oldest first.
function newestWindow<Row>(rows: Row[]): { rows: Row[]; truncated: boolean } {
  return { rows: rows.slice(0, CONTEXT_WINDOW).reverse(), truncated: rows.length > CONTEXT_WINDOW };
}

const getInterviewContext = defineTool({
  name: 'get_interview_context',
  description:
    'Retrieve everything needed to continue or review an interview in one call: the candidate profile, the ' +
    `target job, the interview, the ${CONTEXT_WINDOW} most recent events (oldest first), the candidate's ` +
    `current skill assessments and their ${CONTEXT_WINDOW} most recent changes, and the final evaluations ` +
    'of their five most recently finished other interviews. This is the main read tool during an ' +
    'interview. When events_truncated is true, earlier events exist; read them with list_interview_events. ' +
    'It returns stored data only; it computes no summaries.',
  schema: getInterviewContextInput,
  handler: async (ctx, { interview_id }) => {
    const interview = toInterview(await findInterview(ctx, interview_id));
    const events = newestWindow(
      await ctx.db.query<EventRow>(
        `SELECT id, type, data, created_at FROM interview_events
         WHERE interview_id = $1 AND account_id = $2 ORDER BY id DESC LIMIT $3`,
        [interview_id, ctx.accountId, CONTEXT_WINDOW + 1],
      ),
    );
    const history = newestWindow(
      await ctx.db.query<HistoryRow>(
        `SELECT skill, score, confidence, evidence, interview_id, created_at FROM skill_assessment_history
         WHERE candidate_id = $1 AND account_id = $2 ORDER BY id DESC LIMIT $3`,
        [interview.candidate_id, ctx.accountId, CONTEXT_WINDOW + 1],
      ),
    );
    const recent = await ctx.db.query<PerformanceRow>(
      `SELECT id AS interview_id, job_id, type AS interview_type, finished_at, overall_score, final_evaluation
       FROM interviews
       WHERE candidate_id = $1 AND account_id = $2 AND status = 'completed' AND id <> $3
       ORDER BY finished_at DESC, id DESC
       LIMIT $4`,
      [interview.candidate_id, ctx.accountId, interview_id, RECENT_INTERVIEWS],
    );
    return {
      candidate: await loadProfile(ctx, interview.candidate_id),
      job: await loadJob(ctx, interview.job_id),
      interview,
      previous_events: events.rows.map(toEvent),
      events_truncated: events.truncated,
      skill_history: {
        current: await loadSkills(ctx, interview.candidate_id),
        history: history.rows.map((row) => ({ ...row, created_at: iso(row.created_at) })),
        history_truncated: history.truncated,
      },
      recent_performance: recent.map((row) => ({ ...row, finished_at: iso(row.finished_at) })),
    };
  },
});

export const interviewTools: Tool[] = [
  createInterview,
  recordInterviewEvent,
  getInterviewContext,
  finishInterview,
  listInterviews,
  listInterviewEvents,
];
