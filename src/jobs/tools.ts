import { lockCandidate, requireCandidate } from '../candidates/tools.js';
import { type Ctx, type Tool, defineTool } from '../core/envelope.js';
import { CoachError } from '../core/errors.js';
import { LIMITS, assertWithinLimit } from '../core/limits.js';
import { decodeCursor, paginate, timeKey } from '../core/pagination.js';
import { iso, newId, now } from '../storage/database.js';
import { createTargetJobInput, getTargetJobInput, listTargetJobsInput } from './schemas.js';

interface JobRow {
  id: string;
  candidate_id: string;
  company: string;
  title: string;
  description: string;
  location: string | null;
  requirements: string[];
  metadata: Record<string, unknown>;
  created_at: Date;
}

export async function loadJob(ctx: Ctx, jobId: string) {
  const [row] = await ctx.db.query<JobRow>('SELECT * FROM jobs WHERE id = $1 AND account_id = $2', [
    jobId,
    ctx.accountId,
  ]);
  if (!row) throw new CoachError('JOB_NOT_FOUND', `Job '${jobId}' does not exist.`, 'job_id');
  return {
    job_id: row.id,
    candidate_id: row.candidate_id,
    company: row.company,
    title: row.title,
    description: row.description,
    requirements: row.requirements,
    location: row.location,
    metadata: row.metadata,
    created_at: iso(row.created_at),
  };
}

const createTargetJob = defineTool({
  name: 'create_target_job',
  description:
    'Save a job the candidate is preparing for. company, title and description are required and must come ' +
    'from the user or a real posting; the server never fills in missing job information.',
  schema: createTargetJobInput,
  handler: async (ctx, input) => {
    await lockCandidate(ctx, input.candidate_id);
    const [{ count } = { count: 0 }] = await ctx.db.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM jobs WHERE candidate_id = $1 AND account_id = $2',
      [input.candidate_id, ctx.accountId],
    );
    assertWithinLimit(count, LIMITS.jobsPerCandidate, 'target jobs per candidate');
    const jobId = newId('job');
    await ctx.db.query(
      `INSERT INTO jobs (id, account_id, candidate_id, company, title, description, location, requirements, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10)`,
      [
        jobId,
        ctx.accountId,
        input.candidate_id,
        input.company,
        input.title,
        input.description,
        input.location ?? null,
        JSON.stringify(input.requirements),
        JSON.stringify(input.metadata),
        now(),
      ],
    );
    return loadJob(ctx, jobId);
  },
});

const getTargetJob = defineTool({
  name: 'get_target_job',
  description: 'Retrieve a target job: company, title, full description, requirements, location and metadata.',
  schema: getTargetJobInput,
  handler: (ctx, { job_id }) => loadJob(ctx, job_id),
});

interface JobSummaryRow {
  job_id: string;
  company: string;
  title: string;
  location: string | null;
  created_at: Date;
}

const listTargetJobs = defineTool({
  name: 'list_target_jobs',
  description:
    "List a candidate's target jobs (id, company, title, location), newest first. Returns up to limit jobs " +
    '(default 50); when next_cursor is not null, pass it as cursor to get the next page.',
  schema: listTargetJobsInput,
  handler: async (ctx, { candidate_id, limit, cursor }) => {
    const after = decodeCursor('list_target_jobs', cursor, timeKey);
    await requireCandidate(ctx, candidate_id);
    const rows = await ctx.db.query<JobSummaryRow>(
      `SELECT id AS job_id, company, title, location, created_at FROM jobs
       WHERE candidate_id = $1 AND account_id = $2
         AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4))
       ORDER BY created_at DESC, id DESC
       LIMIT $5`,
      [candidate_id, ctx.accountId, after?.[0] ?? null, after?.[1] ?? null, limit + 1],
    );
    const jobs = rows.map((row) => ({ ...row, created_at: iso(row.created_at) }));
    const { items, next_cursor } = paginate('list_target_jobs', jobs, limit, (row) => [row.created_at, row.job_id]);
    return { jobs: items, next_cursor };
  },
});

export const jobTools: Tool[] = [createTargetJob, getTargetJob, listTargetJobs];
