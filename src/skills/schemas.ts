import { z } from 'zod';
import { confidence, id, score, text } from '../core/primitives.js';

export const updateSkillAssessmentInput = z.strictObject({
  candidate_id: id,
  interview_id: id.optional(),
  skills: z
    .array(
      z.strictObject({
        skill: z.string().trim().toLowerCase().min(1),
        score,
        confidence,
        evidence: text,
      }),
    )
    .min(1)
    .refine((skills) => new Set(skills.map((entry) => entry.skill)).size === skills.length, {
      message: 'each skill may appear only once per call',
    }),
});
