import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type Db, openDb } from '../src/db.js';
import { CoachError } from '../src/errors.js';
import { callTool, defineTool } from '../src/tool.js';

const probe = defineTool({
  name: 'probe',
  description: 'Test-only tool.',
  schema: z.strictObject({
    thing_id: z.string().trim().min(1),
    label: z.string().trim().min(1),
    tags: z.array(z.string()).optional(),
    score: z.number().min(0).max(10).optional(),
    overall_score: z.number().min(0).max(10).optional(),
    category_scores: z.record(z.string(), z.number().min(0).max(10)).optional(),
    confidence: z.number().min(0).max(1).optional(),
    interview_type: z.enum(['technical']).optional(),
    event: z.strictObject({ type: z.enum(['question_asked']) }).optional(),
    mode: z.enum(['ok', 'coach', 'busy', 'constraint', 'boom']).default('ok'),
  }),
  handler: (_db, input) => {
    if (input.mode === 'coach') throw new CoachError('INTERVIEW_NOT_ACTIVE', 'Interview is not active.', 'thing_id');
    if (input.mode === 'busy') throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    if (input.mode === 'constraint') {
      throw Object.assign(new Error('UNIQUE constraint failed: secret_table.col'), {
        code: 'SQLITE_CONSTRAINT_UNIQUE',
      });
    }
    if (input.mode === 'boom') throw new Error('secret detail at /Users/val/private');
    return { echoed: input.label };
  },
});

const base = { thing_id: 't_1', label: 'hello' };

let db: Db;
beforeEach(() => {
  db = openDb(':memory:');
});
afterEach(() => {
  db.close();
});

function error(args: unknown) {
  const env = callTool(db, probe, args);
  if (env.success) throw new Error('expected failure');
  return env.error;
}

describe('callTool success', () => {
  it('returns the handler result as data, with parsed input', () => {
    expect(callTool(db, probe, { thing_id: 't_1', label: '  hello  ' })).toEqual({
      success: true,
      data: { echoed: 'hello' },
    });
  });
});

describe('callTool validation errors', () => {
  it('reports an unknown key as INVALID_FIELD', () => {
    expect(error({ ...base, zzz: 1 })).toEqual({
      code: 'INVALID_FIELD',
      message: "Unknown field 'zzz'.",
      field: 'zzz',
      retryable: false,
    });
  });

  it('reports a nested unknown key with a dotted path', () => {
    expect(error({ ...base, event: { type: 'question_asked', extra: 1 } })).toMatchObject({
      code: 'INVALID_FIELD',
      field: 'event.extra',
    });
  });

  it('reports a wrong type as INVALID_FIELD_TYPE', () => {
    expect(error({ ...base, tags: 'rust' })).toMatchObject({ code: 'INVALID_FIELD_TYPE', field: 'tags' });
  });

  it('reports a missing required field as INVALID_INPUT', () => {
    expect(error({ thing_id: 't_1' })).toMatchObject({ code: 'INVALID_INPUT', field: 'label' });
  });

  it('reports an empty required string as INVALID_INPUT', () => {
    expect(error({ thing_id: 't_1', label: '   ' })).toMatchObject({ code: 'INVALID_INPUT', field: 'label' });
  });

  it.each([[undefined], [''], ['   '], [5], [null]])('reports id %j as INVALID_ID', (value) => {
    expect(error({ label: 'hello', thing_id: value })).toMatchObject({ code: 'INVALID_ID', field: 'thing_id' });
  });

  it.each([[11], [-1], [Number.NaN], [Number.POSITIVE_INFINITY], ['7']])(
    'reports score %j as INVALID_SCORE',
    (value) => {
      expect(error({ ...base, score: value })).toMatchObject({ code: 'INVALID_SCORE', field: 'score' });
      expect(error({ ...base, overall_score: value })).toMatchObject({
        code: 'INVALID_SCORE',
        field: 'overall_score',
      });
      expect(error({ ...base, category_scores: { algorithms: value } })).toMatchObject({
        code: 'INVALID_SCORE',
        field: 'category_scores.algorithms',
      });
    },
  );

  it('reports a non-object category_scores as INVALID_FIELD_TYPE, not INVALID_SCORE', () => {
    expect(error({ ...base, category_scores: 7 })).toMatchObject({
      code: 'INVALID_FIELD_TYPE',
      field: 'category_scores',
    });
  });

  it.each([[1.5], [-0.1], [Number.NaN], ['0.5']])('reports confidence %j as INVALID_CONFIDENCE', (value) => {
    expect(error({ ...base, confidence: value })).toMatchObject({
      code: 'INVALID_CONFIDENCE',
      field: 'confidence',
    });
  });

  it('reports an unknown or missing event type as INVALID_EVENT_TYPE', () => {
    expect(error({ ...base, event: { type: 'made_up' } })).toMatchObject({
      code: 'INVALID_EVENT_TYPE',
      field: 'event.type',
    });
    expect(error({ ...base, event: {} })).toMatchObject({ code: 'INVALID_EVENT_TYPE', field: 'event.type' });
  });

  it('reports an unknown interview type as INVALID_INTERVIEW_TYPE', () => {
    expect(error({ ...base, interview_type: 'vibes' })).toMatchObject({
      code: 'INVALID_INTERVIEW_TYPE',
      field: 'interview_type',
    });
  });

  it('reports the first problem when there are several', () => {
    expect(error({ thing_id: '', label: 5, zzz: 1 })).toMatchObject({ code: 'INVALID_ID', field: 'thing_id' });
  });

  it.each([[undefined], [null]])('treats arguments %j as an empty object', (args) => {
    expect(error(args)).toMatchObject({ code: 'INVALID_ID', field: 'thing_id', retryable: false });
  });

  it('never echoes input values in the message', () => {
    const message = error({ ...base, tags: 'SECRET-VALUE' }).message;
    expect(message).not.toContain('SECRET-VALUE');
  });
});

describe('callTool handler errors', () => {
  it('passes a CoachError through', () => {
    expect(error({ ...base, mode: 'coach' })).toEqual({
      code: 'INTERVIEW_NOT_ACTIVE',
      message: 'Interview is not active.',
      field: 'thing_id',
      retryable: false,
    });
  });

  it('maps SQLite busy to a retryable STORAGE_UNAVAILABLE', () => {
    expect(error({ ...base, mode: 'busy' })).toEqual({
      code: 'STORAGE_UNAVAILABLE',
      message: 'Storage is temporarily unavailable. Retrying may succeed.',
      retryable: true,
    });
  });

  it('maps other SQLite errors to DATABASE_ERROR without leaking details', () => {
    const body = error({ ...base, mode: 'constraint' });
    expect(body).toEqual({
      code: 'DATABASE_ERROR',
      message: 'A database error occurred. The operation was not applied.',
      retryable: false,
    });
    expect(body.message).not.toContain('secret_table');
  });

  it('maps anything else to INTERNAL_ERROR without leaking details', () => {
    const body = error({ ...base, mode: 'boom' });
    expect(body).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'An unexpected internal error occurred.',
      retryable: false,
    });
  });
});
