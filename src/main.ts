#!/usr/bin/env node
import { supabaseRemoveSignIn } from './accounts/sign-in.js';
import { loadConfig } from './config.js';
import { logToStdout } from './core/log.js';
import { RateLimiter } from './core/rate-limit.js';
import { createApp } from './http/app.js';
import { createVerifier, issuerOf } from './http/auth.js';
import { tools } from './registry.js';
import { openDatabase } from './storage/database.js';
import { assertSchemaCurrent } from './storage/migrator.js';

const SHUTDOWN_GRACE_MS = 10_000;

async function start() {
  const config = loadConfig();
  const db = openDatabase(config.databaseUrl);
  // The server never changes the schema; it refuses to serve against one it was not built for.
  await assertSchemaCurrent(db);
  const app = createApp({
    config,
    db,
    tools,
    limiter: new RateLimiter(),
    log: logToStdout,
    verifyToken: createVerifier(issuerOf(config.supabaseUrl)),
    removeSignIn: supabaseRemoveSignIn(config),
  });
  const server = app.listen(config.port, () => {
    logToStdout({ event: 'listening', port: config.port });
  });

  // Stop accepting, let requests in flight finish, then release the database.
  const shutdown = (signal: string) => {
    logToStdout({ event: 'shutting_down', signal });
    const force = setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS);
    force.unref();
    server.close(() => {
      void db.close().finally(() => process.exit(0));
    });
    server.closeIdleConnections();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

try {
  await start();
} catch (error) {
  // One readable line for whoever deployed the server, instead of a stack trace.
  console.error(`interview-coach: cannot start: ${(error as Error).message}`);
  process.exit(1);
}
