import { now, tx } from '../storage/database.js';
import { CoachError } from '../core/errors.js';
import { updateSkillAssessmentInput } from './schemas.js';
import { type Tool, defineTool } from '../core/envelope.js';
import { requireCandidate } from '../candidates/tools.js';

const updateSkillAssessment = defineTool({
  name: 'update_skill_assessment',
  description:
    "Store your current assessment of one or more of the candidate's skills (score 0-10, confidence 0-1, " +
    'with the evidence behind it). Replaces the current value for each skill and appends to its history. ' +
    'Pass interview_id to link the change to the interview that produced it. The server stores the scores ' +
    'you give and never calculates its own. All skills are saved or none are.',
  schema: updateSkillAssessmentInput,
  handler: (db, { candidate_id, interview_id, skills }) =>
    tx(db, () => {
      requireCandidate(db, candidate_id);
      if (interview_id !== undefined) {
        const interview = db.prepare('SELECT candidate_id FROM interviews WHERE id = ?').get(interview_id) as
          | { candidate_id: string }
          | undefined;
        if (!interview || interview.candidate_id !== candidate_id) {
          throw new CoachError(
            'INTERVIEW_NOT_FOUND',
            `Interview '${interview_id}' does not exist for this candidate.`,
            'interview_id',
          );
        }
      }
      const timestamp = now();
      const upsert = db.prepare(
        `INSERT INTO skill_assessments (candidate_id, skill, score, confidence, evidence, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (candidate_id, skill) DO UPDATE SET
           score = excluded.score,
           confidence = excluded.confidence,
           evidence = excluded.evidence,
           updated_at = excluded.updated_at`,
      );
      const append = db.prepare(
        `INSERT INTO skill_assessment_history (candidate_id, skill, score, confidence, evidence, interview_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const entry of skills) {
        upsert.run(candidate_id, entry.skill, entry.score, entry.confidence, entry.evidence, timestamp);
        append.run(
          candidate_id,
          entry.skill,
          entry.score,
          entry.confidence,
          entry.evidence,
          interview_id ?? null,
          timestamp,
        );
      }
      return { candidate_id, updated: skills.map((entry) => ({ ...entry, updated_at: timestamp })) };
    }),
});

export const skillTools: Tool[] = [updateSkillAssessment];
