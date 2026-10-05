import { type Db, newId, now, tx } from '../storage/database.js';
import { CoachError } from '../core/errors.js';
import {
  createCandidateInput,
  getCandidateProfileInput,
  listCandidatesInput,
  updateCandidateProfileInput,
} from './schemas.js';
import { type Tool, defineTool } from '../core/envelope.js';

interface CandidateRow {
  id: string;
  name: string;
  resume: string;
  profile: string;
  version: number;
  created_at: string;
  updated_at: string;
}

interface Profile {
  experience: unknown[];
  projects: unknown[];
  skills: string[];
  interests: string[];
  preferences: string[];
}

interface SkillRow {
  skill: string;
  score: number;
  confidence: number;
  evidence: string;
  updated_at: string;
}

function findCandidate(db: Db, candidateId: string): CandidateRow {
  const row = db.prepare('SELECT * FROM candidates WHERE id = ?').get(candidateId) as CandidateRow | undefined;
  if (!row) {
    throw new CoachError('CANDIDATE_NOT_FOUND', `Candidate '${candidateId}' does not exist.`, 'candidate_id');
  }
  return row;
}

export function requireCandidate(db: Db, candidateId: string): void {
  findCandidate(db, candidateId);
}

export function loadProfile(db: Db, candidateId: string) {
  const row = findCandidate(db, candidateId);
  const skillRows = db
    .prepare(
      'SELECT skill, score, confidence, evidence, updated_at FROM skill_assessments WHERE candidate_id = ? ORDER BY skill',
    )
    .all(candidateId) as SkillRow[];
  const profile = JSON.parse(row.profile) as Profile;
  return {
    candidate_id: row.id,
    name: row.name,
    version: row.version,
    resume: row.resume,
    experience: profile.experience,
    projects: profile.projects,
    skills: profile.skills,
    interests: profile.interests,
    preferences: profile.preferences,
    skill_assessment: Object.fromEntries(skillRows.map(({ skill, ...rest }) => [skill, rest])),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// The name column is COLLATE NOCASE, so '=' ignores case.
function assertNameFree(db: Db, name: string, field: string, exceptId?: string): void {
  const clash = db.prepare('SELECT id FROM candidates WHERE name = ?').get(name) as { id: string } | undefined;
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
  handler: (db, input) =>
    tx(db, () => {
      assertNameFree(db, input.name, 'name');
      const { name, resume, ...profile } = input;
      const candidateId = newId('cand');
      const timestamp = now();
      db.prepare(
        'INSERT INTO candidates (id, name, resume, profile, version, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
      ).run(candidateId, name, resume, JSON.stringify(profile), timestamp, timestamp);
      return loadProfile(db, candidateId);
    }),
});

const getCandidateProfile = defineTool({
  name: 'get_candidate_profile',
  description:
    "Retrieve a candidate's persistent profile: resume, experience, projects, skills, interests, " +
    'preferences and the current skill assessment.',
  schema: getCandidateProfileInput,
  handler: (db, { candidate_id }) => loadProfile(db, candidate_id),
});

const updateCandidateProfile = defineTool({
  name: 'update_candidate_profile',
  description:
    'Persist changes to a candidate profile. Each field in updates REPLACES the stored value whole; ' +
    'arrays are not merged, so send the complete new list. Does not change skill scores; use ' +
    'update_skill_assessment for those.',
  schema: updateCandidateProfileInput,
  handler: (db, { candidate_id, updates }) =>
    tx(db, () => {
      const row = findCandidate(db, candidate_id);
      const { name, resume, ...profileUpdates } = updates;
      if (name !== undefined) assertNameFree(db, name, 'updates.name', candidate_id);
      const supplied = Object.fromEntries(
        Object.entries(profileUpdates).filter(([, value]) => value !== undefined),
      );
      const profile = { ...(JSON.parse(row.profile) as Profile), ...supplied };
      db.prepare(
        'UPDATE candidates SET name = ?, resume = ?, profile = ?, version = version + 1, updated_at = ? WHERE id = ?',
      ).run(name ?? row.name, resume ?? row.resume, JSON.stringify(profile), now(), candidate_id);
      return loadProfile(db, candidate_id);
    }),
});

const listCandidates = defineTool({
  name: 'list_candidates',
  description:
    'List all candidates (id and name only), most recently updated first. Call this at the start of a ' +
    'conversation to find the candidate_id.',
  schema: listCandidatesInput,
  handler: (db) => ({
    candidates: db
      .prepare(
        'SELECT id AS candidate_id, name, created_at, updated_at FROM candidates ORDER BY updated_at DESC, rowid DESC',
      )
      .all(),
  }),
});

export const candidateTools: Tool[] = [createCandidate, getCandidateProfile, updateCandidateProfile, listCandidates];
