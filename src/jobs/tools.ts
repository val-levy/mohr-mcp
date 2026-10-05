import { type Db, newId, now, tx } from '../storage/database.js';
import { CoachError } from '../core/errors.js';
import { createTargetJobInput, getTargetJobInput, listTargetJobsInput } from './schemas.js';
import { type Tool, defineTool } from '../core/envelope.js';
import { requireCandidate } from '../candidates/tools.js';

interface JobRow {
  id: string;
  candidate_id: string;
  company: string;
  title: string;
  description: string;
  location: string | null;
  requirements: string;
  metadata: string;
  created_at: string;
}

export function loadJob(db: Db, jobId: string) {
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as JobRow | undefined;
  if (!row) throw new CoachError('JOB_NOT_FOUND', `Job '${jobId}' does not exist.`, 'job_id');
  return {
    job_id: row.id,
    candidate_id: row.candidate_id,
    company: row.company,
    title: row.title,
    description: row.description,
    requirements: JSON.parse(row.requirements) as string[],
    location: row.location,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    created_at: row.created_at,
  };
}

const createTargetJob = defineTool({
  name: 'create_target_job',
  description:
    'Save a job the candidate is preparing for. company, title and description are required and must come ' +
    'from the user or a real posting; the server never fills in missing job information.',
  schema: createTargetJobInput,
  handler: (db, input) =>
    tx(db, () => {
      requireCandidate(db, input.candidate_id);
      const jobId = newId('job');
      db.prepare(
        'INSERT INTO jobs (id, candidate_id, company, title, description, location, requirements, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        jobId,
        input.candidate_id,
        input.company,
        input.title,
        input.description,
        input.location ?? null,
        JSON.stringify(input.requirements),
        JSON.stringify(input.metadata),
        now(),
      );
      return loadJob(db, jobId);
    }),
});

const getTargetJob = defineTool({
  name: 'get_target_job',
  description: 'Retrieve a target job: company, title, full description, requirements, location and metadata.',
  schema: getTargetJobInput,
  handler: (db, { job_id }) => loadJob(db, job_id),
});

const listTargetJobs = defineTool({
  name: 'list_target_jobs',
  description: "List a candidate's target jobs (id, company, title, location), newest first.",
  schema: listTargetJobsInput,
  handler: (db, { candidate_id }) => {
    requireCandidate(db, candidate_id);
    return {
      jobs: db
        .prepare(
          'SELECT id AS job_id, company, title, location, created_at FROM jobs WHERE candidate_id = ? ORDER BY created_at DESC, rowid DESC',
        )
        .all(candidate_id),
    };
  },
});

export const jobTools: Tool[] = [createTargetJob, getTargetJob, listTargetJobs];
