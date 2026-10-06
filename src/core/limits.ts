import { CoachError } from './errors.js';

/** Ceilings per account. They bound storage and stop a looping client; they are not product tiers. */
export const LIMITS = {
  candidates: 10,
  jobsPerCandidate: 200,
  activeInterviewsPerCandidate: 20,
  eventsPerInterview: 5_000,
} as const;

export function assertWithinLimit(count: number, limit: number, what: string): void {
  if (count >= limit) {
    throw new CoachError('LIMIT_EXCEEDED', `Limit reached: at most ${limit} ${what}.`);
  }
}
