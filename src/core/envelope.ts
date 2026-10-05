import type { z } from 'zod';
import type { Db } from '../storage/database.js';
import { type ErrorBody, fromZodError, toErrorBody } from './errors.js';

export type Envelope = { success: true; data: unknown } | { success: false; error: ErrorBody };

export interface Tool {
  name: string;
  description: string;
  schema: z.ZodType;
  run(db: Db, input: unknown): unknown;
}

export function defineTool<S extends z.ZodType>(def: {
  name: string;
  description: string;
  schema: S;
  handler: (db: Db, input: z.output<S>) => unknown;
}): Tool {
  return {
    name: def.name,
    description: def.description,
    schema: def.schema,
    run: (db, input) => def.handler(db, input as z.output<S>),
  };
}

export function callTool(db: Db, tool: Tool, rawArgs: unknown): Envelope {
  const args = rawArgs ?? {};
  try {
    const parsed = tool.schema.safeParse(args);
    if (!parsed.success) throw fromZodError(parsed.error, args);
    return { success: true, data: tool.run(db, parsed.data) };
  } catch (err) {
    return { success: false, error: toErrorBody(err) };
  }
}
