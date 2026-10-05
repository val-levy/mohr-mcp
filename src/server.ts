import { readFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Db } from './db.js';
import { type Envelope, callTool } from './tool.js';
import { tools } from './tools/index.js';

// Resolves against the package root from both src/ and the compiled dist/.
function readPackageFile(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

type ObjectSchema = { type: 'object'; [key: string]: unknown };

export function buildServer(db: Db): Server {
  const { version } = JSON.parse(readPackageFile('package.json')) as { version: string };
  const instructions = readPackageFile('prompts/server_instructions.md').trim();
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const server = new Server({ name: 'interview-coach', version }, { capabilities: { tools: {} }, instructions });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.schema, { io: 'input', unrepresentable: 'any' }) as unknown as ObjectSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const started = performance.now();
    const { name } = request.params;
    const tool = byName.get(name);
    const envelope: Envelope = tool
      ? callTool(db, tool, request.params.arguments)
      : {
          success: false,
          error: { code: 'INVALID_INPUT', message: `Unknown tool '${name}'.`, retryable: false },
        };
    // Outcome only: never arguments or results, which hold resumes and answers.
    console.error(
      JSON.stringify({
        tool: name,
        ok: envelope.success,
        ...(envelope.success ? {} : { code: envelope.error.code }),
        ms: Math.round(performance.now() - started),
      }),
    );
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(envelope) }],
      isError: !envelope.success,
    };
  });

  return server;
}
