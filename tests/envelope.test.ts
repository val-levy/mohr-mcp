import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CoachError } from '../src/core/errors.js';
import { callTool, defineTool } from '../src/core/envelope.js';
import { RateLimiter } from '../src/core/rate-limit.js';
import { ACCOUNT, OTHER_ACCOUNT, advance, rows, useDb } from './helpers.js';

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
  handler: async (_ctx, input) => {
    if (input.mode === 'coach') throw new CoachError('INTERVIEW_NOT_ACTIVE', 'Interview is not active.', 'thing_id');
    if (input.mode === 'busy') throw Object.assign(new Error('could not serialize access'), { code: '40001' });
    if (input.mode === 'constraint') {
      throw Object.assign(new Error('duplicate key value violates unique constraint "secret_table_col"'), { code: '23505' });
    }
    if (input.mode === 'boom') throw new Error('secret detail at /Users/val/private');
    return { echoed: input.label };
  },
});

const base = { thing_id: 't_1', label: 'hello' };

const getDb = useDb();

function run(args: unknown, accountId = ACCOUNT, limiter = new RateLimiter()) {
  return callTool({ db: getDb(), limiter }, accountId, probe, args);
}

async function error(args: unknown) {
  const env = await run(args);
  if (env.success) throw new Error('expected failure');
  return env.error;
}

describe('callTool success', () => {
  it('returns the handler result as data, with parsed input', async () => {
    expect(await run({ thing_id: 't_1', label: '  hello  ' })).toEqual({
      success: true,
      data: { echoed: 'hello' },
    });
  });
});

describe('callTool validation errors', () => {
  it('reports an unknown key as INVALID_FIELD', async () => {
    expect(await error({ ...base, zzz: 1 })).toEqual({
      code: 'INVALID_FIELD',
      message: "Unknown field 'zzz'.",
      field: 'zzz',
      retryable: false,
    });
  });

  it('reports a nested unknown key with a dotted path', async () => {
    expect(await error({ ...base, event: { type: 'question_asked', extra: 1 } })).toMatchObject({
      code: 'INVALID_FIELD',
      field: 'event.extra',
    });
  });

  it('reports a wrong type as INVALID_FIELD_TYPE', async () => {
    expect(await error({ ...base, tags: 'rust' })).toMatchObject({ code: 'INVALID_FIELD_TYPE', field: 'tags' });
  });

  it('reports a missing required field as INVALID_INPUT', async () => {
    expect(await error({ thing_id: 't_1' })).toMatchObject({ code: 'INVALID_INPUT', field: 'label' });
  });

  it('reports an empty required string as INVALID_INPUT', async () => {
    expect(await error({ thing_id: 't_1', label: '   ' })).toMatchObject({ code: 'INVALID_INPUT', field: 'label' });
  });

  it.each([[undefined], [''], ['   '], [5], [null]])('reports id %j as INVALID_ID', async (value) => {
    expect(await error({ label: 'hello', thing_id: value })).toMatchObject({ code: 'INVALID_ID', field: 'thing_id' });
  });

  it.each([[11], [-1], [Number.NaN], [Number.POSITIVE_INFINITY], ['7']])(
    'reports score %j as INVALID_SCORE',
    async (value) => {
      expect(await error({ ...base, score: value })).toMatchObject({ code: 'INVALID_SCORE', field: 'score' });
      expect(await error({ ...base, overall_score: value })).toMatchObject({
        code: 'INVALID_SCORE',
        field: 'overall_score',
      });
      expect(await error({ ...base, category_scores: { algorithms: value } })).toMatchObject({
        code: 'INVALID_SCORE',
        field: 'category_scores.algorithms',
      });
    },
  );

  it('reports a non-object category_scores as INVALID_FIELD_TYPE, not INVALID_SCORE', async () => {
    expect(await error({ ...base, category_scores: 7 })).toMatchObject({
      code: 'INVALID_FIELD_TYPE',
      field: 'category_scores',
    });
  });

  it.each([[1.5], [-0.1], [Number.NaN], ['0.5']])('reports confidence %j as INVALID_CONFIDENCE', async (value) => {
    expect(await error({ ...base, confidence: value })).toMatchObject({
      code: 'INVALID_CONFIDENCE',
      field: 'confidence',
    });
  });

  it('reports an unknown or missing event type as INVALID_EVENT_TYPE', async () => {
    expect(await error({ ...base, event: { type: 'made_up' } })).toMatchObject({
      code: 'INVALID_EVENT_TYPE',
      field: 'event.type',
    });
    expect(await error({ ...base, event: {} })).toMatchObject({ code: 'INVALID_EVENT_TYPE', field: 'event.type' });
  });

  it('reports an unknown interview type as INVALID_INTERVIEW_TYPE', async () => {
    expect(await error({ ...base, interview_type: 'vibes' })).toMatchObject({
      code: 'INVALID_INTERVIEW_TYPE',
      field: 'interview_type',
    });
  });

  it('reports the first problem when there are several', async () => {
    expect(await error({ thing_id: '', label: 5, zzz: 1 })).toMatchObject({ code: 'INVALID_ID', field: 'thing_id' });
  });

  it.each([[undefined], [null]])('treats arguments %j as an empty object', async (args) => {
    expect(await error(args)).toMatchObject({ code: 'INVALID_ID', field: 'thing_id', retryable: false });
  });

  it('never echoes input values in the message', async () => {
    const message = (await error({ ...base, tags: 'SECRET-VALUE' })).message;
    expect(message).not.toContain('SECRET-VALUE');
  });
});

describe('callTool handler errors', () => {
  it('passes a CoachError through', async () => {
    expect(await error({ ...base, mode: 'coach' })).toEqual({
      code: 'INTERVIEW_NOT_ACTIVE',
      message: 'Interview is not active.',
      field: 'thing_id',
      retryable: false,
    });
  });

  it('maps a transient database failure to a retryable STORAGE_UNAVAILABLE', async () => {
    expect(await error({ ...base, mode: 'busy' })).toEqual({
      code: 'STORAGE_UNAVAILABLE',
      message: 'Storage is temporarily unavailable. Retrying may succeed.',
      retryable: true,
    });
  });

  it('maps other database errors to DATABASE_ERROR without leaking details', async () => {
    const body = await error({ ...base, mode: 'constraint' });
    expect(body).toEqual({
      code: 'DATABASE_ERROR',
      message: 'A database error occurred. The operation was not applied.',
      retryable: false,
    });
    expect(body.message).not.toContain('secret_table');
  });

  it('maps anything else to INTERNAL_ERROR without leaking details', async () => {
    const body = await error({ ...base, mode: 'boom' });
    expect(body).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'An unexpected internal error occurred.',
      retryable: false,
    });
  });
});

describe('callTool accounts', () => {
  it('creates the account on its first call and not again', async () => {
    await run(base);
    await run(base);
    expect(await rows('SELECT id FROM accounts')).toEqual([{ id: ACCOUNT }]);
  });

  it('does not create an account for a call that fails', async () => {
    await run({ ...base, mode: 'boom' });
    expect(await rows('SELECT id FROM accounts')).toEqual([]);
  });
});

describe('callTool rate limit', () => {
  it('refuses calls over the limit with a retryable error, per account', async () => {
    const limiter = new RateLimiter(2);
    expect((await run(base, ACCOUNT, limiter)).success).toBe(true);
    expect((await run(base, ACCOUNT, limiter)).success).toBe(true);
    expect(await run(base, ACCOUNT, limiter)).toEqual({
      success: false,
      error: { code: 'RATE_LIMITED', message: 'Too many requests. Wait a minute before trying again.', retryable: true },
    });
    expect((await run(base, OTHER_ACCOUNT, limiter)).success).toBe(true);
  });

  it('allows calls again once the minute has passed', async () => {
    const limiter = new RateLimiter(1);
    await run(base, ACCOUNT, limiter);
    expect((await run(base, ACCOUNT, limiter)).success).toBe(false);
    advance(60_000);
    expect((await run(base, ACCOUNT, limiter)).success).toBe(true);
  });
});
