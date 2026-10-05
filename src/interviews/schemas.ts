import { z } from 'zod';
import { id, score, strings, text } from '../core/primitives.js';

export const EVENT_MAX = 50_000;
export const INTERVIEW_TYPES = ['technical', 'behavioral', 'system_design'] as const;
export const EVENT_TYPES = [
  'question_asked',
  'question_answered',
  'hint_requested',
  'hint_given',
  'follow_up',
  'evaluation',
  'topic_completed',
] as const;

export const createInterviewInput = z.strictObject({
  candidate_id: id,
  job_id: id,
  interview_type: z.enum(INTERVIEW_TYPES),
});

export const recordInterviewEventInput = z.strictObject({
  interview_id: id,
  event: z
    .strictObject({
      type: z.enum(EVENT_TYPES),
      category: text.optional(),
      difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
      question: text.optional(),
      answer: z.string().optional(),
      hints_used: z.number().int().min(0).optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    })
    .refine((event) => JSON.stringify(event).length <= EVENT_MAX, {
      message: `event must serialize to at most ${EVENT_MAX} characters`,
    }),
});

export const finishInterviewInput = z.strictObject({
  interview_id: id,
  overall_score: score,
  category_scores: z.record(z.string(), score),
  strengths: strings,
  weaknesses: strings,
  recommendations: strings,
});

export const listInterviewsInput = z.strictObject({
  candidate_id: id,
  status: z.enum(['active', 'completed']).optional(),
});

export const getInterviewContextInput = z.strictObject({ interview_id: id });
