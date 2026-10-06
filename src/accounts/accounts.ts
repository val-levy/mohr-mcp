import { CoachError } from '../core/errors.js';
import { type Database, type Queryable, now, withAccount } from '../storage/database.js';

// Advisory lock namespace for accounts; the second key is a hash of the account ID.
const ACCOUNT_LOCK = 7101;

/**
 * Makes sure the account making this call has a row, creating it on first use. last_seen_at is
 * refreshed at most once an hour so that reads do not become a write on every call.
 *
 * A deleted account stays deleted: a token issued before the deletion must not start it again.
 */
export async function ensureAccount(db: Queryable, accountId: string): Promise<void> {
  // Shared with other calls, exclusive against deletion: a call either finishes before the account is
  // deleted or starts after and sees that it was. Without it, a call could pass the check below while
  // a deletion was committing and leave data behind for a deleted account.
  await db.query('SELECT pg_advisory_xact_lock_shared($1, hashtext($2))', [ACCOUNT_LOCK, accountId]);
  const deleted = await db.query('SELECT 1 FROM deleted_accounts WHERE id = $1', [accountId]);
  if (deleted.length > 0) {
    throw new CoachError('ACCOUNT_DELETED', 'This account was deleted. Sign in again to start a new one.');
  }
  const timestamp = now();
  await db.query(
    `INSERT INTO accounts (id, created_at, last_seen_at) VALUES ($1, $2, $2)
     ON CONFLICT (id) DO UPDATE SET last_seen_at = excluded.last_seen_at
     WHERE accounts.last_seen_at < excluded.last_seen_at - interval '1 hour'`,
    [accountId, timestamp],
  );
}

/**
 * Deletes the account and, by cascade, everything stored for it, and records that it was deleted.
 * Returns false if it had no data.
 */
export async function deleteAccount(db: Database, accountId: string): Promise<boolean> {
  const deleted = await withAccount(db, accountId, async (tx) => {
    // Waits for the account's calls in flight to finish, and holds back new ones until this commits.
    await tx.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [ACCOUNT_LOCK, accountId]);
    await tx.query('INSERT INTO deleted_accounts (id, deleted_at) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [
      accountId,
      now(),
    ]);
    return tx.query('DELETE FROM accounts WHERE id = $1 RETURNING id', [accountId]);
  });
  return deleted.length > 0;
}
