import type { z } from 'zod';
import { ensureAccount } from '../accounts/accounts.js';
import { type Database, type Queryable, withAccount } from '../storage/database.js';
import { CoachError, type ErrorBody, fromZodError, toErrorBody } from './errors.js';
import type { RateLimiter } from './rate-limit.js';

export type Envelope = { success: true; data: unknown } | { success: false; error: ErrorBody };

/** What a handler works with: a transaction limited to one account, and that account's ID. */
export interface Ctx {
  db: Queryable;
  accountId: string;
}

export interface Tool {
  name: string;
  description: string;
  schema: z.ZodType;
  run(ctx: Ctx, input: unknown): Promise<unknown>;
}

export interface ToolDeps {
  db: Database;
  limiter: RateLimiter;
}

export function defineTool<S extends z.ZodType>(def: {
  name: string;
  description: string;
  schema: S;
  handler: (ctx: Ctx, input: z.output<S>) => Promise<unknown>;
}): Tool {
  return {
    name: def.name,
    description: def.description,
    schema: def.schema,
    run: (ctx, input) => def.handler(ctx, input as z.output<S>),
  };
}

/** Runs one tool call for one account. The whole call is a single transaction: all of it applies or none. */
export async function callTool(deps: ToolDeps, accountId: string, tool: Tool, rawArgs: unknown): Promise<Envelope> {
  const args = rawArgs ?? {};
  try {
    if (!deps.limiter.allow(accountId)) {
      throw new CoachError('RATE_LIMITED', 'Too many requests. Wait a minute before trying again.');
    }
    const parsed = tool.schema.safeParse(args);
    if (!parsed.success) throw fromZodError(parsed.error, args);
    const data = await withAccount(deps.db, accountId, async (tx) => {
      await ensureAccount(tx, accountId);
      return tool.run({ db: tx, accountId }, parsed.data);
    });
    return { success: true, data };
  } catch (err) {
    return { success: false, error: toErrorBody(err) };
  }
}
