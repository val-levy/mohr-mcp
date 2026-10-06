import { type JWTVerifyGetKey, createRemoteJWKSet, jwtVerify } from 'jose';

/** Resolves to the account ID a bearer token was issued for; rejects when the token is not acceptable. */
export type VerifyToken = (token: string) => Promise<string>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where Supabase Auth issues tokens from for a project. */
export function issuerOf(supabaseUrl: string): string {
  return `${supabaseUrl}/auth/v1`;
}

/**
 * Accepts only tokens signed by `issuer` with an asymmetric key, unexpired, for a signed-in person.
 * `keys` is injectable so tests can sign with their own key pair.
 */
export function createVerifier(issuer: string, keys?: JWTVerifyGetKey): VerifyToken {
  const keySet = keys ?? createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  return async (token) => {
    const { payload } = await jwtVerify(token, keySet, {
      issuer,
      // Never a shared-secret algorithm: only the issuer can have produced the signature.
      algorithms: ['ES256', 'RS256'],
      requiredClaims: ['sub', 'exp'],
    });
    if (payload.role !== 'authenticated' || payload.is_anonymous === true) {
      throw new Error('Token is not for a signed-in person.');
    }
    if (typeof payload.sub !== 'string' || !UUID.test(payload.sub)) {
      throw new Error('Token subject is not an account ID.');
    }
    return payload.sub.toLowerCase();
  };
}

/** The token of an `Authorization: Bearer <token>` header, if that is what the header holds. */
export function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer +([^\s]+)$/i.exec(header ?? '');
  return match?.[1];
}
