import type { z } from 'zod';

export const ERROR_CODES = [
  'INVALID_INPUT',
  'INVALID_FIELD',
  'INVALID_FIELD_TYPE',
  'INVALID_ID',
  'CANDIDATE_NOT_FOUND',
  'JOB_NOT_FOUND',
  'INTERVIEW_NOT_FOUND',
  'INTERVIEW_NOT_ACTIVE',
  'INTERVIEW_ALREADY_COMPLETED',
  'INVALID_EVENT_TYPE',
  'INVALID_INTERVIEW_TYPE',
  'INVALID_SCORE',
  'INVALID_CONFIDENCE',
  'DUPLICATE_RESOURCE',
  'CONFLICT',
  'INVALID_CURSOR',
  'LIMIT_EXCEEDED',
  'RATE_LIMITED',
  'DATABASE_ERROR',
  'STORAGE_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorBody {
  code: ErrorCode;
  message: string;
  field?: string;
  retryable: boolean;
}

const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['STORAGE_UNAVAILABLE', 'RATE_LIMITED']);

export class CoachError extends Error {
  readonly code: ErrorCode;
  readonly field?: string;

  constructor(code: ErrorCode, message: string, field?: string) {
    super(message);
    this.name = 'CoachError';
    this.code = code;
    if (field !== undefined) this.field = field;
  }
}

type Issue = z.ZodError['issues'][number];

function valueAt(raw: unknown, path: readonly PropertyKey[]): unknown {
  let current = raw;
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<PropertyKey, unknown>)[key];
  }
  return current;
}

function classify(issue: Issue, raw: unknown): ErrorCode {
  const path = issue.path;
  const last = path[path.length - 1];
  // Before the _id check: category names are free text and may end in _id.
  if (path.length === 2 && path[0] === 'category_scores') return 'INVALID_SCORE';
  if (typeof last === 'string' && last.endsWith('_id')) return 'INVALID_ID';
  if (last === 'score' || last === 'overall_score') return 'INVALID_SCORE';
  if (last === 'confidence') return 'INVALID_CONFIDENCE';
  if (path.length === 2 && path[0] === 'event' && last === 'type') return 'INVALID_EVENT_TYPE';
  if (last === 'interview_type') return 'INVALID_INTERVIEW_TYPE';
  if (issue.code === 'invalid_type' && valueAt(raw, path) !== undefined) return 'INVALID_FIELD_TYPE';
  return 'INVALID_INPUT';
}

export function fromZodError(error: z.ZodError, raw: unknown): CoachError {
  const issue = error.issues[0];
  if (issue === undefined) return new CoachError('INVALID_INPUT', 'Invalid input.');
  if (issue.code === 'unrecognized_keys') {
    const field = [...issue.path, issue.keys[0]].map(String).join('.');
    return new CoachError('INVALID_FIELD', `Unknown field '${field}'.`, field);
  }
  const field = issue.path.map(String).join('.');
  const where = field === '' ? 'input' : `'${field}'`;
  return new CoachError(classify(issue, raw), `Invalid ${where}: ${issue.message}`, field === '' ? undefined : field);
}

// Postgres reports a five-character SQLSTATE; these classes mean "try again", not "your input is wrong".
// 08: connection failure. 40001/40P01: serialization failure, deadlock. 53: out of resources.
// 57: cancelled or shutting down (includes a statement timeout). 55P03: lock not available.
const TRANSIENT_SQLSTATE = /^(08...|40001|40P01|53...|57...|55P03)$/;
const NETWORK_ERRORS: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
]);

type StorageFailure = 'transient' | 'permanent' | undefined;

function storageFailure(err: unknown): StorageFailure {
  if (!(err instanceof Error)) return undefined;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string') {
    if (NETWORK_ERRORS.has(code) || TRANSIENT_SQLSTATE.test(code)) return 'transient';
    if (/^[0-9A-Z]{5}$/.test(code)) return 'permanent';
  }
  // The pool gave up waiting for a free connection, or lost one mid-query.
  if (/timeout exceeded when trying to connect|Connection terminated/i.test(err.message)) return 'transient';
  return undefined;
}

export function toErrorBody(err: unknown): ErrorBody {
  if (err instanceof CoachError) {
    return {
      code: err.code,
      message: err.message,
      ...(err.field !== undefined ? { field: err.field } : {}),
      retryable: RETRYABLE.has(err.code),
    };
  }
  const failure = storageFailure(err);
  if (failure === 'transient') {
    return {
      code: 'STORAGE_UNAVAILABLE',
      message: 'Storage is temporarily unavailable. Retrying may succeed.',
      retryable: true,
    };
  }
  if (failure === 'permanent') {
    return {
      code: 'DATABASE_ERROR',
      message: 'A database error occurred. The operation was not applied.',
      retryable: false,
    };
  }
  return { code: 'INTERNAL_ERROR', message: 'An unexpected internal error occurred.', retryable: false };
}
