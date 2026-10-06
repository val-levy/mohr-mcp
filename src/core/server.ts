import { readFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { type Envelope, type Tool, type ToolDeps, callTool } from './envelope.js';
import type { Log } from './log.js';
import { packagePath } from './paths.js';

function readPackageFile(relativePath: string): string {
  return readFileSync(packagePath(relativePath), 'utf8');
}

type ObjectSchema = { type: 'object'; [key: string]: unknown };

export interface ServerDeps extends ToolDeps {
  tools: Tool[];
  log: Log;
}

/** Who is calling, established by the HTTP layer before the protocol server is built. */
export interface Caller {
  accountId: string;
  requestId: string;
}

// A protocol server is built for every request, so everything that does not depend on the caller is
// read and computed once.
let shipped: { version: string; instructions: string } | undefined;

function shippedFiles() {
  shipped ??= {
    version: (JSON.parse(readPackageFile('package.json')) as { version: string }).version,
    instructions: readPackageFile('prompts/server_instructions.md').trim(),
  };
  return shipped;
}

const listings = new WeakMap<Tool[], { name: string; description: string; inputSchema: ObjectSchema }[]>();

function listingOf(tools: Tool[]) {
  let listing = listings.get(tools);
  if (!listing) {
    listing = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.schema, { io: 'input', unrepresentable: 'any' }) as unknown as ObjectSchema,
    }));
    listings.set(tools, listing);
  }
  return listing;
}

export function buildServer(deps: ServerDeps, caller: Caller): Server {
  const { version, instructions } = shippedFiles();
  const server = new Server({ name: 'interview-coach', version }, { capabilities: { tools: {} }, instructions });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listingOf(deps.tools) }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const started = performance.now();
    const { name } = request.params;
    const tool = deps.tools.find((candidate) => candidate.name === name);
    const envelope: Envelope = tool
      ? await callTool(deps, caller.accountId, tool, request.params.arguments)
      : {
          success: false,
          error: { code: 'INVALID_INPUT', message: `Unknown tool '${name}'.`, retryable: false },
        };
    // Outcome only: never arguments or results, which hold resumes and answers.
    deps.log({
      request_id: caller.requestId,
      account_id: caller.accountId,
      tool: name,
      ok: envelope.success,
      ...(envelope.success ? {} : { code: envelope.error.code }),
      ms: Math.round(performance.now() - started),
    });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(envelope) }],
      isError: !envelope.success,
    };
  });

  return server;
}
