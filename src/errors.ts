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

const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['STORAGE_UNAVAILABLE']);

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
  if (typeof last === 'string' && last.endsWith('_id')) return 'INVALID_ID';
  if (last === 'score' || last === 'overall_score') return 'INVALID_SCORE';
  if (path.length === 2 && path[0] === 'category_scores') return 'INVALID_SCORE';
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

function sqliteCode(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && code.startsWith('SQLITE_') ? code : undefined;
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
  const code = sqliteCode(err);
  if (code !== undefined) {
    if (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED')) {
      return {
        code: 'STORAGE_UNAVAILABLE',
        message: 'Storage is temporarily unavailable. Retrying may succeed.',
        retryable: true,
      };
    }
    return {
      code: 'DATABASE_ERROR',
      message: 'A database error occurred. The operation was not applied.',
      retryable: false,
    };
  }
  return { code: 'INTERNAL_ERROR', message: 'An unexpected internal error occurred.', retryable: false };
}
