import { type Database, type Queryable, now, withAccount } from '../storage/database.js';

/**
 * Makes sure the account making this call has a row, creating it on first use. last_seen_at is
 * refreshed at most once an hour so that reads do not become a write on every call.
 */
export async function ensureAccount(db: Queryable, accountId: string): Promise<void> {
  const timestamp = now();
  await db.query(
    `INSERT INTO accounts (id, created_at, last_seen_at) VALUES ($1, $2, $2)
     ON CONFLICT (id) DO UPDATE SET last_seen_at = excluded.last_seen_at
     WHERE accounts.last_seen_at < excluded.last_seen_at - interval '1 hour'`,
    [accountId, timestamp],
  );
}

/** Deletes the account and, by cascade, everything stored for it. Returns false if it had no data. */
export async function deleteAccount(db: Database, accountId: string): Promise<boolean> {
  const deleted = await withAccount(db, accountId, (tx) =>
    tx.query('DELETE FROM accounts WHERE id = $1 RETURNING id', [accountId]),
  );
  return deleted.length > 0;
}
