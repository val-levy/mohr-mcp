import { z } from 'zod';
import { CoachError } from './errors.js';

export const PAGE_DEFAULT = 50;
export const PAGE_MAX = 100;

/** Input fields shared by every list tool. */
export const pageInput = {
  limit: z.number().int().min(1).max(PAGE_MAX).default(PAGE_DEFAULT),
  cursor: z.string().min(1).optional(),
};

/** Position of the last row of a page ordered by a timestamp, then by ID. */
export const timeKey = z.tuple([z.iso.datetime(), z.string().min(1)]);
/** Position of the last row of a page ordered by a numeric ID. */
export const idKey = z.tuple([z.number().int().positive()]);

function invalid(): CoachError {
  return new CoachError('INVALID_CURSOR', 'Invalid cursor: pass next_cursor from the previous call unchanged.', 'cursor');
}

/** A cursor is the tool it belongs to and the sort position of the last row returned. */
function encodeCursor(tool: string, key: readonly unknown[]): string {
  return Buffer.from(JSON.stringify([tool, ...key])).toString('base64url');
}

/** Returns the position a cursor points at, or undefined for the first page. */
export function decodeCursor<K extends z.ZodType>(tool: string, cursor: string | undefined, key: K): z.output<K> | undefined {
  if (cursor === undefined) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  if (!Array.isArray(decoded) || decoded[0] !== tool) throw invalid();
  const parsed = key.safeParse(decoded.slice(1));
  if (!parsed.success) throw invalid();
  return parsed.data;
}

/**
 * Splits `rows`, fetched with LIMIT `limit + 1`, into the page to return and the cursor for the next
 * one. The extra row only tells us whether more exist.
 */
export function paginate<Row>(
  tool: string,
  rows: Row[],
  limit: number,
  keyOf: (row: Row) => readonly unknown[],
): { items: Row[]; next_cursor: string | null } {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    next_cursor: rows.length > limit && last !== undefined ? encodeCursor(tool, keyOf(last)) : null,
  };
}
