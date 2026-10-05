#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer } from './core/server.js';
import { tools } from './registry.js';
import { defaultDbPath, openDb } from './storage/database.js';

const db = openDb(defaultDbPath());
const server = buildServer(db, tools);

// Close the database cleanly so the WAL is checkpointed into the main file.
async function shutdown(): Promise<void> {
  await server.close();
  db.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await server.connect(new StdioServerTransport());
console.error('interview-coach MCP server running on stdio');
