import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { RateLimiter } from '../src/core/rate-limit.js';
import { createApp } from '../src/http/app.js';
import { acceptedAudiences, bearerToken, createVerifier, issuerOf } from '../src/http/auth.js';
import { tools } from '../src/registry.js';
import { ACCOUNT, OTHER_ACCOUNT, ok, rows, useDb } from './helpers.js';

const getDb = useDb();

const config: Config = {
  port: 0,
  publicUrl: 'https://coach.test',
  supabaseUrl: 'https://project.supabase.test',
  supabasePublishableKey: 'publishable-key',
  supabaseServiceKey: 'SERVICE-KEY-SECRET',
  databaseUrl: 'postgres://unused',
};
const ISSUER = issuerOf(config.supabaseUrl);
const CHALLENGE = 'resource_metadata="https://coach.test/.well-known/oauth-protected-resource/mcp"';

type Key = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let signingKey: Key;
let foreignKey: Key;
let verifyToken: ReturnType<typeof createVerifier>;

beforeAll(async () => {
  const pair = await generateKeyPair('ES256');
  signingKey = pair.privateKey;
  foreignKey = (await generateKeyPair('ES256')).privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'ES256', use: 'sig' };
  verifyToken = createVerifier(ISSUER, acceptedAudiences(config), createLocalJWKSet({ keys: [jwk] }));
});

interface TokenOptions {
  sub?: string;
  claims?: Record<string, unknown>;
  issuer?: string;
  expiresIn?: number;
  /** null leaves the audience out. */
  audience?: string | null;
  key?: Key;
}

/** A token as Supabase Auth issues them, signed with the test key unless told otherwise. */
function token(options: TokenOptions = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const jwt = new SignJWT({ role: 'authenticated', is_anonymous: false, ...options.claims });
  if (options.audience !== null) jwt.setAudience(options.audience ?? 'authenticated');
  return jwt
    .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
    .setSubject(options.sub ?? ACCOUNT)
    .setIssuer(options.issuer ?? ISSUER)
    .setIssuedAt(now)
    .setExpirationTime(now + (options.expiresIn ?? 3600))
    .sign(options.key ?? signingKey);
}

let http: HttpServer;
let base: string;
let logged: Record<string, unknown>[];
let removed: string[];
let removeSignInFails: boolean;

beforeEach(async () => {
  logged = [];
  removed = [];
  removeSignInFails = false;
  const app = createApp({
    config,
    db: getDb(),
    tools,
    limiter: new RateLimiter(1_000_000),
    log: (entry) => logged.push(entry),
    verifyToken,
    removeSignIn: async (accountId) => {
      if (removeSignInFails) throw new Error('identity provider is down');
      removed.push(accountId);
    },
  });
  http = await new Promise<HttpServer>((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterEach(async () => {
  http.closeAllConnections();
  await new Promise((resolve) => http.close(resolve));
});

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
};

function post(body: unknown, authorization?: string): Promise<Response> {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(authorization === undefined ? {} : { authorization }),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function connect(accountId = ACCOUNT): Promise<Client> {
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const authorization = `Bearer ${await token({ sub: accountId })}`;
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization } } }),
  );
  return client;
}

async function callOver(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const [content] = result.content as Array<{ type: string; text: string }>;
  return { isError: result.isError === true, envelope: JSON.parse(content?.text ?? 'null') };
}

describe('POST /mcp without an acceptable token', () => {
  it('answers 401 and says where to sign in when there is no token', async () => {
    const response = await post(INITIALIZE);
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(`Bearer ${CHALLENGE}`);
    expect(await response.json()).toEqual({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Sign-in required.' },
      id: null,
    });
  });

  it.each([['Basic dXNlcjpwYXNz'], ['Bearer'], ['Bearer two parts'], ['']])(
    'treats the header %j as no token',
    async (authorization) => {
      const response = await post(INITIALIZE, authorization);
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe(`Bearer ${CHALLENGE}`);
    },
  );

  it.each<[string, () => Promise<string>]>([
    ['is not a token at all', async () => 'garbage'],
    ['is signed by a key the issuer does not have', () => token({ key: foreignKey })],
    ['comes from another issuer', () => token({ issuer: 'https://evil.test/auth/v1' })],
    ['has expired', () => token({ expiresIn: -60 })],
    ['is for an anonymous sign-in', () => token({ claims: { is_anonymous: true } })],
    ['has the anon role', () => token({ claims: { role: 'anon' } })],
    ['has the service role', () => token({ claims: { role: 'service_role' } })],
    ['has a subject that is not an account ID', () => token({ sub: 'not-a-uuid' })],
    ['was issued for another service', () => token({ audience: 'https://other.test/mcp' })],
    ['names no audience', () => token({ audience: null })],
    [
      'is signed with a shared secret',
      () =>
        new SignJWT({ role: 'authenticated', aud: 'authenticated' })
          .setProtectedHeader({ alg: 'HS256' })
          .setSubject(ACCOUNT)
          .setIssuer(ISSUER)
          .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
          .sign(new TextEncoder().encode('a-shared-secret-of-sufficient-length')),
    ],
    [
      'is unsigned',
      async () => {
        const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
        const exp = Math.floor(Date.now() / 1000) + 3600;
        return `${part({ alg: 'none' })}.${part({ sub: ACCOUNT, iss: ISSUER, aud: 'authenticated', role: 'authenticated', exp })}.`;
      },
    ],
  ])('answers 401 invalid_token when the token %s', async (_case, make) => {
    const response = await post(INITIALIZE, `Bearer ${await make()}`);
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(`Bearer error="invalid_token", ${CHALLENGE}`);
    expect(await rows('SELECT id FROM accounts')).toEqual([]);
  });

  it('does not read the body of a request it will refuse', async () => {
    const response = await post('{ this is not json');
    expect(response.status).toBe(401);
  });
});

describe('bearerToken', () => {
  it('reads the token whatever the case of the scheme', () => {
    expect(bearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(bearerToken('bearer abc')).toBe('abc');
    expect(bearerToken(undefined)).toBeUndefined();
  });
});

describe('POST /mcp with a valid token', () => {
  it('lists the 15 tools with closed input schemas and gives the instructions', async () => {
    const client = await connect();
    expect(client.getServerVersion()).toMatchObject({ name: 'interview-coach' });
    expect(client.getInstructions()).toContain('list_candidates');
    const listed = (await client.listTools()).tools;
    expect(listed.map((tool) => tool.name).sort()).toEqual(tools.map((tool) => tool.name).sort());
    expect(listed).toHaveLength(15);
    for (const tool of listed) {
      expect(tool.description, tool.name).toBeTruthy();
      expect(tool.inputSchema, tool.name).toMatchObject({ type: 'object', additionalProperties: false });
    }
  });

  it('runs a whole interview for the signed-in account', async () => {
    const client = await connect();
    const candidate = await callOver(client, 'create_candidate', { name: 'Val', resume: 'PRIVATE RESUME' });
    expect(candidate.isError).toBe(false);
    const candidateId: string = candidate.envelope.data.candidate_id;
    const job = await callOver(client, 'create_target_job', {
      candidate_id: candidateId,
      company: 'Acme',
      title: 'SWE',
      description: 'Build.',
    });
    const interview = await callOver(client, 'create_interview', {
      candidate_id: candidateId,
      job_id: job.envelope.data.job_id,
      interview_type: 'technical',
    });
    const interviewId: string = interview.envelope.data.interview_id;
    await callOver(client, 'record_interview_event', {
      interview_id: interviewId,
      event: { type: 'question_asked', question: 'Shortest path?' },
    });
    const context = await callOver(client, 'get_interview_context', { interview_id: interviewId });
    expect(context.envelope).toMatchObject({
      success: true,
      data: { previous_events: [{ type: 'question_asked', question: 'Shortest path?' }], events_truncated: false },
    });
    expect(await rows('SELECT id FROM accounts')).toEqual([{ id: ACCOUNT }]);
  });

  it('keeps accounts apart', async () => {
    const mine = await connect();
    const created = await callOver(mine, 'create_candidate', { name: 'Val' });
    const theirs = await connect(OTHER_ACCOUNT);
    expect((await callOver(theirs, 'list_candidates')).envelope.data.candidates).toEqual([]);
    const read = await callOver(theirs, 'get_candidate_profile', { candidate_id: created.envelope.data.candidate_id });
    expect(read.isError).toBe(true);
    expect(read.envelope.error.code).toBe('CANDIDATE_NOT_FOUND');
  });

  it('reports a failed tool call as an error result, not a protocol error', async () => {
    const client = await connect();
    const result = await callOver(client, 'create_candidate', {});
    expect(result.isError).toBe(true);
    expect(result.envelope).toMatchObject({ success: false, error: { code: 'INVALID_INPUT', field: 'name' } });
  });

  it('reports an unknown tool as an error result', async () => {
    const client = await connect();
    const result = await callOver(client, 'drop_everything');
    expect(result.isError).toBe(true);
    expect(result.envelope.error.code).toBe('INVALID_INPUT');
  });

  it('accepts a token issued for this service by address', async () => {
    const authorization = `Bearer ${await token({ audience: 'https://coach.test/mcp' })}`;
    const response = await post({ jsonrpc: '2.0', id: 7, method: 'tools/list' }, authorization);
    expect(response.status).toBe(200);
  });

  it('needs no session: any request can stand alone', async () => {
    const response = await post({ jsonrpc: '2.0', id: 7, method: 'tools/list' }, `Bearer ${await token()}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('mcp-session-id')).toBeNull();
    expect((await response.json()).result.tools).toHaveLength(15);
  });

  it('answers 400 to a body that is not JSON', async () => {
    const response = await post('{ this is not json', `Bearer ${await token()}`);
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe(-32700);
  });

  it('answers 413 to a body over 1 MB', async () => {
    const big = { ...INITIALIZE, padding: 'x'.repeat(1_100_000) };
    const response = await post(big, `Bearer ${await token()}`);
    expect(response.status).toBe(413);
  });
});

describe('logging', () => {
  it('records who called what and how it went, never what was said', async () => {
    const client = await connect();
    await callOver(client, 'create_candidate', { name: 'Val Levy', resume: 'PRIVATE RESUME' });
    await callOver(client, 'create_candidate', { name: 'Val Levy' });
    const calls = logged.filter((entry) => 'tool' in entry);
    expect(calls).toEqual([
      { request_id: expect.any(String), account_id: ACCOUNT, tool: 'create_candidate', ok: true, ms: expect.any(Number) },
      {
        request_id: expect.any(String),
        account_id: ACCOUNT,
        tool: 'create_candidate',
        ok: false,
        code: 'DUPLICATE_RESOURCE',
        ms: expect.any(Number),
      },
    ]);
    const text = JSON.stringify(logged);
    expect(text).not.toContain('PRIVATE RESUME');
    expect(text).not.toContain('Val Levy');
    expect(text).not.toContain('eyJ');
  });

  it('records the path of a request without its query string', async () => {
    await fetch(`${base}/authorize?authorization_id=SECRET-CODE`);
    expect(logged).toEqual([
      { request_id: expect.any(String), method: 'GET', path: '/authorize', status: 200, ms: expect.any(Number) },
    ]);
  });
});

describe('discovery', () => {
  it.each([['/.well-known/oauth-protected-resource'], ['/.well-known/oauth-protected-resource/mcp']])(
    'describes the protected resource at %s',
    async (path) => {
      const response = await fetch(`${base}${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(await response.json()).toEqual({
        resource: 'https://coach.test/mcp',
        authorization_servers: ['https://project.supabase.test/auth/v1'],
        bearer_methods_supported: ['header'],
        resource_name: 'Interview Coach',
      });
    },
  );

  it.each([['GET'], ['DELETE'], ['PUT']])('answers 405 to %s /mcp', async (method) => {
    const response = await fetch(`${base}/mcp`, { method });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });
});

describe('health', () => {
  it('is alive without touching the database', async () => {
    const response = await fetch(`${base}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('is ready when the schema is current', async () => {
    const response = await fetch(`${base}/readyz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ready' });
  });

  it('is not ready when the schema is not the one it was built for', async () => {
    const [applied] = await rows<{ checksum: string }>('SELECT checksum FROM schema_migrations');
    await getDb().query("UPDATE schema_migrations SET checksum = 'changed'");
    try {
      const response = await fetch(`${base}/readyz`);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ status: 'not ready' });
    } finally {
      await getDb().query('UPDATE schema_migrations SET checksum = $1', [applied?.checksum]);
    }
  });
});

describe('pages', () => {
  it.each([
    ['/', 'text/html'],
    ['/authorize', 'text/html'],
    ['/account', 'text/html'],
    ['/assets/styles.css', 'text/css'],
    ['/assets/client.js', 'text/javascript'],
    ['/assets/authorize.js', 'text/javascript'],
    ['/assets/account.js', 'text/javascript'],
    ['/assets/index.js', 'text/javascript'],
    ['/assets/supabase.js', 'text/javascript'],
  ])('serves %s', async (path, type) => {
    const response = await fetch(`${base}${path}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain(type);
    expect((await response.text()).length).toBeGreaterThan(0);
  });

  it('sends headers that forbid framing, sniffing and outside scripts', async () => {
    const response = await fetch(`${base}/authorize`);
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-powered-by')).toBeNull();
    expect(response.headers.get('content-security-policy')).toBe(
      "default-src 'self'; connect-src 'self' https://project.supabase.test; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
  });

  it('loads every script and stylesheet from this origin, with nothing inline', async () => {
    for (const path of ['/', '/authorize', '/account']) {
      const html = await (await fetch(`${base}${path}`)).text();
      const sources = [...html.matchAll(/<(?:script|link)\b[^>]*?(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
      expect(sources.length, path).toBeGreaterThan(0);
      for (const source of sources) expect(source, path).toMatch(/^\/assets\//);
      expect(html, path).not.toMatch(/<script(?![^>]*\bsrc=)/);
      expect(html, path).not.toMatch(/\son[a-z]+=|<style|style="/);
    }
  });

  it('gives the pages their settings, and never the service key', async () => {
    const response = await fetch(`${base}/config.json`);
    expect(await response.json()).toEqual({
      supabaseUrl: 'https://project.supabase.test',
      supabasePublishableKey: 'publishable-key',
      connectorUrl: 'https://coach.test/mcp',
    });
  });

  it('answers 404 to anything else, including paths outside the assets folder', async () => {
    for (const path of ['/nope', '/assets/missing.js', '/assets/..%2f..%2fpackage.json', '/package.json']) {
      const response = await fetch(`${base}${path}`);
      expect(response.status, path).toBe(404);
      expect(await response.text(), path).not.toContain('interview-coach-mcp');
    }
  });
});

describe('DELETE /account', () => {
  async function deleteAccountOver(authorization?: string): Promise<Response> {
    return fetch(`${base}/account`, { method: 'DELETE', headers: authorization ? { authorization } : {} });
  }

  it('refuses without a token and deletes nothing', async () => {
    await ok('create_candidate', { name: 'Val' });
    const response = await deleteAccountOver();
    expect(response.status).toBe(401);
    expect(await rows('SELECT id FROM accounts')).toEqual([{ id: ACCOUNT }]);
    expect(removed).toEqual([]);
  });

  it('deletes everything stored for the caller, removes their sign-in, and leaves others alone', async () => {
    await ok('create_candidate', { name: 'Val' });
    await ok('create_candidate', { name: 'Sam' }, OTHER_ACCOUNT);
    const response = await deleteAccountOver(`Bearer ${await token()}`);
    expect(response.status).toBe(204);
    expect(await rows('SELECT account_id FROM candidates')).toEqual([{ account_id: OTHER_ACCOUNT }]);
    expect(await rows('SELECT id FROM accounts')).toEqual([{ id: OTHER_ACCOUNT }]);
    expect(removed).toEqual([ACCOUNT]);
  });

  it('refuses a token that was issued to a connected app, and deletes nothing', async () => {
    await ok('create_candidate', { name: 'Val' });
    const response = await deleteAccountOver(`Bearer ${await token({ claims: { client_id: 'an-assistant' } })}`);
    expect(response.status).toBe(403);
    expect(response.headers.get('www-authenticate')).toContain('error="insufficient_scope"');
    expect(await rows('SELECT id FROM accounts')).toEqual([{ id: ACCOUNT }]);
    expect(removed).toEqual([]);
  });

  it('stops a token that is still valid from starting the account again', async () => {
    const client = await connect();
    await callOver(client, 'create_candidate', { name: 'Val' });
    expect((await deleteAccountOver(`Bearer ${await token()}`)).status).toBe(204);
    const after = await callOver(client, 'create_candidate', { name: 'Val' });
    expect(after.envelope).toEqual({
      success: false,
      error: {
        code: 'ACCOUNT_DELETED',
        message: 'This account was deleted. Sign in again to start a new one.',
        retryable: false,
      },
    });
    expect(await rows('SELECT id FROM accounts')).toEqual([]);
    expect(await rows('SELECT id FROM candidates')).toEqual([]);
  });

  it('can be repeated after it has already succeeded', async () => {
    await ok('create_candidate', { name: 'Val' });
    await deleteAccountOver(`Bearer ${await token()}`);
    expect((await deleteAccountOver(`Bearer ${await token()}`)).status).toBe(204);
    expect(removed).toEqual([ACCOUNT, ACCOUNT]);
  });

  it('removes the sign-in of someone who never stored anything', async () => {
    const response = await deleteAccountOver(`Bearer ${await token()}`);
    expect(response.status).toBe(204);
    expect(removed).toEqual([ACCOUNT]);
  });

  it('says so when the data is gone but the sign-in could not be removed', async () => {
    await ok('create_candidate', { name: 'Val' });
    removeSignInFails = true;
    const response = await deleteAccountOver(`Bearer ${await token()}`);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: 'Your data was deleted, but removing your sign-in failed. Please try again.',
    });
    expect(await rows('SELECT id FROM accounts')).toEqual([]);
    expect(logged).toContainEqual({
      request_id: expect.any(String),
      account_id: ACCOUNT,
      event: 'remove_sign_in_failed',
    });
  });
});
