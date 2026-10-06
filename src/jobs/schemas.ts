import { z } from 'zod';
import { pageInput } from '../core/pagination.js';
import { id, strings, text } from '../core/primitives.js';

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

export const listTargetJobsInput = z.strictObject({ candidate_id: id, ...pageInput });
