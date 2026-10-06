import type { Config } from '../config.js';
import { type JWTVerifyGetKey, createRemoteJWKSet, jwtVerify } from 'jose';

export interface Identity {
  accountId: string;
  /** Set when the token was issued to a connected app such as an assistant, not to our own pages. */
  clientId?: string;
}

/** Resolves to who a bearer token was issued for; rejects when the token is not acceptable. */
export type VerifyToken = (token: string) => Promise<Identity>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where Supabase Auth issues tokens from for a project. */
export function issuerOf(supabaseUrl: string): string {
  return `${supabaseUrl}/auth/v1`;
}

/**
 * The audiences a token may name: Supabase's audience for signed-in people, or this service by
 * address. A token issued for anything else is refused.
 */
export function acceptedAudiences(config: Config): string[] {
  return ['authenticated', config.publicUrl, `${config.publicUrl}/mcp`];
}

/**
 * Accepts only tokens signed by `issuer` with an asymmetric key, unexpired, naming one of
 * `audiences`, for a signed-in person. `keys` is injectable so tests can sign with their own key pair.
 */
export function createVerifier(issuer: string, audiences: string[], keys?: JWTVerifyGetKey): VerifyToken {
  const keySet = keys ?? createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  return async (token) => {
    const { payload } = await jwtVerify(token, keySet, {
      issuer,
      audience: audiences,
      // Never a shared-secret algorithm: only the issuer can have produced the signature.
      algorithms: ['ES256', 'RS256'],
      requiredClaims: ['sub', 'exp', 'aud'],
    });
    if (payload.role !== 'authenticated' || payload.is_anonymous === true) {
      throw new Error('Token is not for a signed-in person.');
    }
    if (typeof payload.sub !== 'string' || !UUID.test(payload.sub)) {
      throw new Error('Token subject is not an account ID.');
    }
    const clientId = typeof payload.client_id === 'string' && payload.client_id !== '' ? payload.client_id : undefined;
    return { accountId: payload.sub.toLowerCase(), ...(clientId === undefined ? {} : { clientId }) };
  };
}

/** The token of an `Authorization: Bearer <token>` header, if that is what the header holds. */
export function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer +([^\s]+)$/i.exec(header ?? '');
  return match?.[1];
}
