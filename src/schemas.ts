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
