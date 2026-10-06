import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { type ErrorRequestHandler, type Express, type RequestHandler, type Response } from 'express';
import { deleteAccount } from '../accounts/accounts.js';
import type { RemoveSignIn } from '../accounts/sign-in.js';
import type { Config } from '../config.js';
import { packagePath } from '../core/paths.js';
import { type ServerDeps, buildServer } from '../core/server.js';
import { assertSchemaCurrent } from '../storage/migrator.js';
import { type VerifyToken, bearerToken } from './auth.js';
import { MCP_PATH, RESOURCE_METADATA_PATH, challenge, resourceMetadata } from './metadata.js';

export interface AppDeps extends ServerDeps {
  config: Config;
  verifyToken: VerifyToken;
  removeSignIn: RemoveSignIn;
}

const BODY_LIMIT = '1mb';
// The browser build of the Supabase client, served from our own origin so the pages load no third-party script.
const SUPABASE_BROWSER_CLIENT = createRequire(import.meta.url).resolve('@supabase/supabase-js/dist/umd/supabase.js');

interface Locals {
  requestId: string;
  accountId?: string;
  /** The connected app the caller's token was issued to, if any. */
  clientId?: string;
}

function localsOf(res: Response): Locals {
  return res.locals as Locals;
}

function rpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}

export function createApp(deps: AppDeps): Express {
  const { config, log } = deps;
  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    const started = performance.now();
    localsOf(res).requestId = randomUUID();
    res.setHeader('X-Request-Id', localsOf(res).requestId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // The consent page must never be framed by another site.
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'self'; connect-src 'self' ${config.supabaseUrl}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
    );
    res.on('finish', () => {
      // The path only: query strings can carry sign-in codes.
      log({
        request_id: localsOf(res).requestId,
        ...(localsOf(res).accountId ? { account_id: localsOf(res).accountId } : {}),
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Math.round(performance.now() - started),
      });
    });
    next();
  });

  /** Lets the request through only with a valid token, and records whose it is. */
  const authenticate: RequestHandler = async (req, res, next) => {
    const token = bearerToken(req.headers.authorization);
    if (token === undefined) {
      res.setHeader('WWW-Authenticate', challenge(config));
      rpcError(res, 401, -32001, 'Sign-in required.');
      return;
    }
    try {
      const identity = await deps.verifyToken(token);
      localsOf(res).accountId = identity.accountId;
      localsOf(res).clientId = identity.clientId;
    } catch {
      res.setHeader('WWW-Authenticate', challenge(config, 'invalid_token'));
      rpcError(res, 401, -32001, 'The sign-in has expired or is not valid.');
      return;
    }
    next();
  };

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/readyz', async (_req, res) => {
    try {
      await assertSchemaCurrent(deps.db);
      res.json({ status: 'ready' });
    } catch {
      res.status(503).json({ status: 'not ready' });
    }
  });

  const metadata: RequestHandler = (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json(resourceMetadata(config));
  };
  app.get(RESOURCE_METADATA_PATH, metadata);
  app.get(`${RESOURCE_METADATA_PATH}${MCP_PATH}`, metadata);

  app.post(MCP_PATH, authenticate, express.json({ limit: BODY_LIMIT }), async (req, res) => {
    const accountId = localsOf(res).accountId as string;
    // Stateless: a server and transport per request, so any instance can answer any request.
    const server = buildServer(deps, { accountId, requestId: localsOf(res).requestId });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.all(MCP_PATH, (_req, res) => {
    res.setHeader('Allow', 'POST');
    rpcError(res, 405, -32000, 'Method not allowed. Send requests with POST.');
  });

  // Sign-in and account pages: static files, configured through /config.json.
  const page =
    (file: string): RequestHandler =>
    (_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.sendFile(packagePath(`web/${file}`));
    };
  app.get('/', page('index.html'));
  app.get('/authorize', page('authorize.html'));
  app.get('/account', page('account.html'));
  app.get('/config.json', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      supabaseUrl: config.supabaseUrl,
      supabasePublishableKey: config.supabasePublishableKey,
      connectorUrl: `${config.publicUrl}${MCP_PATH}`,
    });
  });
  app.get('/assets/supabase.js', (_req, res) => {
    res.sendFile(SUPABASE_BROWSER_CLIENT);
  });
  app.use('/assets', express.static(packagePath('web/assets'), { index: false, fallthrough: false }));

  app.delete('/account', authenticate, async (_req, res) => {
    const accountId = localsOf(res).accountId as string;
    // Only the person, signed in on the account page, may delete the account: never an app acting for them.
    if (localsOf(res).clientId !== undefined) {
      res.setHeader('WWW-Authenticate', 'Bearer error="insufficient_scope"');
      res.status(403).json({ error: 'Delete your account from the account page.' });
      return;
    }
    await deleteAccount(deps.db, accountId);
    try {
      await deps.removeSignIn(accountId);
    } catch {
      log({ request_id: localsOf(res).requestId, account_id: accountId, event: 'remove_sign_in_failed' });
      res.status(502).json({ error: 'Your data was deleted, but removing your sign-in failed. Please try again.' });
      return;
    }
    res.status(204).end();
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found.' });
  });

  const onError: ErrorRequestHandler = (error: { status?: number; type?: string; name?: string }, _req, res, _next) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (error.type === 'entity.too.large') return rpcError(res, 413, -32600, 'Request body is too large.');
    if (error.type === 'entity.parse.failed') return rpcError(res, 400, -32700, 'Request body is not valid JSON.');
    // Anything else the client got wrong is a path the static files refused: missing, malformed or outside the folder.
    if (error.status !== undefined && error.status >= 400 && error.status < 500) {
      res.status(404).json({ error: 'Not found.' });
      return;
    }
    log({ request_id: localsOf(res).requestId, event: 'unhandled_error', name: error.name });
    rpcError(res, 500, -32603, 'An unexpected internal error occurred.');
  };
  app.use(onError);

  return app;
}
