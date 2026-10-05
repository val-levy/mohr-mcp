import { z } from 'zod';

export const RESUME_MAX = 100_000;
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

export const id = z.string().trim().min(1);
export const text = z.string().trim().min(1);
export const strings = z.array(text);
export const score = z.number().min(0).max(10);
export const confidence = z.number().min(0).max(1);

const resume = z.string().max(RESUME_MAX);
const experience = z.array(
  z.strictObject({
    title: text,
    organization: text,
    start: text.optional(),
    end: text.optional(),
    description: text.optional(),
  }),
);
const projects = z.array(
  z.strictObject({
    name: text,
    description: text,
    technologies: strings.optional(),
    url: text.optional(),
  }),
);

export const createCandidateInput = z.strictObject({
  name: text,
  resume: resume.default(''),
  experience: experience.default([]),
  projects: projects.default([]),
  skills: strings.default([]),
  interests: strings.default([]),
  preferences: strings.default([]),
});

export const getCandidateProfileInput = z.strictObject({ candidate_id: id });

export const updateCandidateProfileInput = z.strictObject({
  candidate_id: id,
  updates: z
    .strictObject({
      name: text.optional(),
      resume: resume.optional(),
      experience: experience.optional(),
      projects: projects.optional(),
      skills: strings.optional(),
      interests: strings.optional(),
      preferences: strings.optional(),
    })
    .refine((updates) => Object.values(updates).some((value) => value !== undefined), {
      message: 'updates must contain at least one field',
    }),
});

export const listCandidatesInput = z.strictObject({});

export const createTargetJobInput = z.strictObject({
  candidate_id: id,
  company: text,
  title: text,
  description: text,
  location: text.optional(),
  requirements: strings.default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export const getTargetJobInput = z.strictObject({ job_id: id });

export const listTargetJobsInput = z.strictObject({ candidate_id: id });

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
