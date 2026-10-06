import { type Ctx, type Tool, defineTool } from '../core/envelope.js';
import { CoachError } from '../core/errors.js';
import { LIMITS, assertWithinLimit } from '../core/limits.js';
import { decodeCursor, paginate, timeKey } from '../core/pagination.js';
import { iso, newId, now } from '../storage/database.js';
import {
  createCandidateInput,
  deleteCandidateInput,
  getCandidateProfileInput,
  listCandidatesInput,
  updateCandidateProfileInput,
} from './schemas.js';

interface Profile {
  experience: unknown[];
  projects: unknown[];
  skills: string[];
  interests: string[];
  preferences: string[];
}

interface CandidateRow {
  id: string;
  name: string;
  name_key: string;
  resume: string;
  profile: Profile;
  version: number;
  created_at: Date;
  updated_at: Date;
}

interface SkillRow {
  skill: string;
  score: number;
  confidence: number;
  evidence: string;
  updated_at: Date;
}

// A candidate in another account is reported exactly like one that does not exist.
async function findCandidate(ctx: Ctx, candidateId: string, lock = false): Promise<CandidateRow> {
  const [row] = await ctx.db.query<CandidateRow>(
    `SELECT * FROM candidates WHERE id = $1 AND account_id = $2${lock ? ' FOR UPDATE' : ''}`,
    [candidateId, ctx.accountId],
  );
  if (!row) {
    throw new CoachError('CANDIDATE_NOT_FOUND', `Candidate '${candidateId}' does not exist.`, 'candidate_id');
  }
  return row;
}

export async function requireCandidate(ctx: Ctx, candidateId: string): Promise<void> {
  await findCandidate(ctx, candidateId);
}

/** Like requireCandidate, and holds the candidate until the transaction ends so counts under it stay true. */
export async function lockCandidate(ctx: Ctx, candidateId: string): Promise<void> {
  await findCandidate(ctx, candidateId, true);
}

export async function loadSkills(ctx: Ctx, candidateId: string) {
  const rows = await ctx.db.query<SkillRow>(
    `SELECT skill, score, confidence, evidence, updated_at FROM skill_assessments
     WHERE candidate_id = $1 AND account_id = $2 ORDER BY skill`,
    [candidateId, ctx.accountId],
  );
  return rows.map((row) => ({ ...row, updated_at: iso(row.updated_at) }));
}

export async function loadProfile(ctx: Ctx, candidateId: string) {
  const row = await findCandidate(ctx, candidateId);
  const skills = await loadSkills(ctx, candidateId);
  return {
    candidate_id: row.id,
    name: row.name,
    version: row.version,
    resume: row.resume,
    experience: row.profile.experience,
    projects: row.profile.projects,
    skills: row.profile.skills,
    interests: row.profile.interests,
    preferences: row.profile.preferences,
    skill_assessment: Object.fromEntries(skills.map(({ skill, ...rest }) => [skill, rest])),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

// Names are unique within an account ignoring case in any script.
function nameKey(name: string): string {
  return name.normalize('NFKC').toLowerCase();
}

// Creating and renaming candidates take turns per account, so the checks below cannot be raced.
async function lockAccount(ctx: Ctx): Promise<void> {
  await ctx.db.query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [ctx.accountId]);
}

async function assertNameFree(ctx: Ctx, name: string, field: string, exceptId?: string): Promise<void> {
  const [clash] = await ctx.db.query<{ id: string }>(
    'SELECT id FROM candidates WHERE account_id = $1 AND name_key = $2',
    [ctx.accountId, nameKey(name)],
  );
  if (clash && clash.id !== exceptId) {
    throw new CoachError(
      'DUPLICATE_RESOURCE',
      `A candidate named '${name}' already exists (candidate_id '${clash.id}').`,
      field,
    );
  }
}

const createCandidate = defineTool({
  name: 'create_candidate',
  description:
    'Create a new candidate. Call list_candidates first to check the person does not already exist. ' +
    'Names are unique ignoring case. Returns the full profile including the new candidate_id.',
  schema: createCandidateInput,
  handler: async (ctx, input) => {
    await lockAccount(ctx);
    const [{ count } = { count: 0 }] = await ctx.db.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM candidates WHERE account_id = $1',
      [ctx.accountId],
    );
    assertWithinLimit(count, LIMITS.candidates, 'candidates per account');
    await assertNameFree(ctx, input.name, 'name');
    const { name, resume, ...profile } = input;
    const candidateId = newId('cand');
    await ctx.db.query(
      `INSERT INTO candidates (id, account_id, name, name_key, resume, profile, version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, 1, $7, $7)`,
      [candidateId, ctx.accountId, name, nameKey(name), resume, JSON.stringify(profile), now()],
    );
    return loadProfile(ctx, candidateId);
  },
});

const getCandidateProfile = defineTool({
  name: 'get_candidate_profile',
  description:
    "Retrieve a candidate's persistent profile: resume, experience, projects, skills, interests, " +
    'preferences and the current skill assessment.',
  schema: getCandidateProfileInput,
  handler: (ctx, { candidate_id }) => loadProfile(ctx, candidate_id),
});

const updateCandidateProfile = defineTool({
  name: 'update_candidate_profile',
  description:
    'Persist changes to a candidate profile. Each field in updates REPLACES the stored value whole; ' +
    'arrays are not merged, so send the complete new list. Does not change skill scores; use ' +
    'update_skill_assessment for those.',
  schema: updateCandidateProfileInput,
  handler: async (ctx, { candidate_id, updates }) => {
    const { name, resume, ...profileUpdates } = updates;
    if (name !== undefined) await lockAccount(ctx);
    const row = await findCandidate(ctx, candidate_id, true);
    if (name !== undefined) await assertNameFree(ctx, name, 'updates.name', candidate_id);
    const supplied = Object.fromEntries(Object.entries(profileUpdates).filter(([, value]) => value !== undefined));
    const profile = { ...row.profile, ...supplied };
    await ctx.db.query(
      `UPDATE candidates
       SET name = $1, name_key = $2, resume = $3, profile = $4::jsonb, version = version + 1, updated_at = $5
       WHERE id = $6 AND account_id = $7`,
      [
        name ?? row.name,
        nameKey(name ?? row.name),
        resume ?? row.resume,
        JSON.stringify(profile),
        now(),
        candidate_id,
        ctx.accountId,
      ],
    );
    return loadProfile(ctx, candidate_id);
  },
});

interface CandidateSummaryRow {
  candidate_id: string;
  name: string;
  created_at: Date;
  updated_at: Date;
}

const listCandidates = defineTool({
  name: 'list_candidates',
  description:
    'List the candidates in this account (id and name only), most recently updated first. Call this at the ' +
    'start of a conversation to find the candidate_id. Returns up to limit candidates (default 50); when ' +
    'next_cursor is not null, pass it as cursor to get the next page.',
  schema: listCandidatesInput,
  handler: async (ctx, { limit, cursor }) => {
    const after = decodeCursor('list_candidates', cursor, timeKey);
    const rows = await ctx.db.query<CandidateSummaryRow>(
      `SELECT id AS candidate_id, name, created_at, updated_at FROM candidates
       WHERE account_id = $1 AND ($2::timestamptz IS NULL OR (updated_at, id) < ($2::timestamptz, $3))
       ORDER BY updated_at DESC, id DESC
       LIMIT $4`,
      [ctx.accountId, after?.[0] ?? null, after?.[1] ?? null, limit + 1],
    );
    const candidates = rows.map((row) => ({ ...row, created_at: iso(row.created_at), updated_at: iso(row.updated_at) }));
    const { items, next_cursor } = paginate('list_candidates', candidates, limit, (row) => [
      row.updated_at,
      row.candidate_id,
    ]);
    return { candidates: items, next_cursor };
  },
});

const deleteCandidate = defineTool({
  name: 'delete_candidate',
  description:
    'Permanently delete a candidate together with all their jobs, interviews, recorded events and skill ' +
    'history. This cannot be undone. Only call it after the person has explicitly asked for the deletion; ' +
    "confirm_name must be the candidate's name, as confirmation that the right profile is being deleted.",
  schema: deleteCandidateInput,
  handler: async (ctx, { candidate_id, confirm_name }) => {
    const row = await findCandidate(ctx, candidate_id, true);
    if (nameKey(confirm_name) !== row.name_key) {
      throw new CoachError(
        'INVALID_INPUT',
        "confirm_name does not match the candidate's name. Nothing was deleted.",
        'confirm_name',
      );
    }
    await ctx.db.query('DELETE FROM candidates WHERE id = $1 AND account_id = $2', [candidate_id, ctx.accountId]);
    return { candidate_id, deleted: true };
  },
});

export const candidateTools: Tool[] = [
  createCandidate,
  getCandidateProfile,
  updateCandidateProfile,
  listCandidates,
  deleteCandidate,
];
