import type { Config } from '../config.js';

/** Removes a person's sign-in from the identity provider. Resolves when it is gone or was already gone. */
export type RemoveSignIn = (accountId: string) => Promise<void>;

const TIMEOUT_MS = 10_000;

export function supabaseRemoveSignIn(config: Config): RemoveSignIn {
  return async (accountId) => {
    const response = await fetch(`${config.supabaseUrl}/auth/v1/admin/users/${accountId}`, {
      method: 'DELETE',
      headers: { apikey: config.supabaseServiceKey, authorization: `Bearer ${config.supabaseServiceKey}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`Removing the sign-in failed with status ${response.status}.`);
    }
  };
}
