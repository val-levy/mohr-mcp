import { z } from 'zod';
import { pageInput } from '../core/pagination.js';
import { id, strings, text } from '../core/primitives.js';

export const RESUME_MAX = 100_000;

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

export const listCandidatesInput = z.strictObject({ ...pageInput });

export const deleteCandidateInput = z.strictObject({ candidate_id: id, confirm_name: text });
