import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Db, openDb } from '../src/storage/database.js';
import { buildServer } from '../src/core/server.js';
import { tools } from '../src/registry.js';

const packageVersion: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

let db: Db;
let client: Client;
let logged: string[];

beforeEach(async () => {
  logged = [];
  vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => {
    logged.push(parts.map(String).join(' '));
  });
  db = openDb(':memory:');
  const server = buildServer(db, tools);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
});

afterEach(async () => {
  await client.close();
  db.close();
  vi.restoreAllMocks();
});

async function call(name: string, args?: Record<string, unknown>) {
  const result = await client.callTool(args === undefined ? { name } : { name, arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  expect(content).toHaveLength(1);
  expect(content[0]?.type).toBe('text');
  return { isError: result.isError === true, envelope: JSON.parse(content[0]?.text ?? '') };
}

async function data(name: string, args?: Record<string, unknown>) {
  const { isError, envelope } = await call(name, args);
  expect(envelope.success).toBe(true);
  expect(isError).toBe(false);
  return envelope.data;
}

describe('server metadata', () => {
  it('identifies itself and gives usage instructions', () => {
    expect(client.getServerVersion()).toMatchObject({ name: 'interview-coach', version: packageVersion });
    const instructions = client.getInstructions() ?? '';
    expect(instructions).toContain('list_candidates');
    expect(instructions).toContain('update_skill_assessment');
    expect(instructions).toContain('finish_interview');
    expect(instructions).toContain('success');
  });

  it('lists 13 tools, each with a strict object input schema', async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(13);
    for (const tool of tools) {
      expect(tool.description?.length ?? 0).toBeGreaterThan(20);
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
    const create = tools.find((t) => t.name === 'create_candidate');
    expect(create?.inputSchema.required).toEqual(['name']);
    const record = tools.find((t) => t.name === 'record_interview_event');
    expect(record?.inputSchema.required).toEqual(['interview_id', 'event']);
  });
});

describe('tool calls over the protocol', () => {
  it('runs a whole interview end to end', async () => {
    const candidate = await data('create_candidate', { name: 'Val', resume: 'Resume', skills: ['Go'] });
    const job = await data('create_target_job', {
      candidate_id: candidate.candidate_id,
      company: 'Palantir',
      title: 'SWE Intern',
      description: 'Build data platforms.',
    });
    const interview = await data('create_interview', {
      candidate_id: candidate.candidate_id,
      job_id: job.job_id,
      interview_type: 'technical',
    });
    await data('record_interview_event', {
      interview_id: interview.interview_id,
      event: { type: 'question_asked', category: 'graphs', question: 'Shortest path?' },
    });
    await data('record_interview_event', {
      interview_id: interview.interview_id,
      event: { type: 'question_answered', category: 'graphs', answer: 'BFS.', hints_used: 1 },
    });
    await data('update_skill_assessment', {
      candidate_id: candidate.candidate_id,
      interview_id: interview.interview_id,
      skills: [{ skill: 'graphs', score: 6, confidence: 0.8, evidence: 'Solved with one hint.' }],
    });
    await data('finish_interview', {
      interview_id: interview.interview_id,
      overall_score: 7.2,
      category_scores: { algorithms: 7 },
      strengths: ['Systems reasoning'],
      weaknesses: ['Graph algorithms'],
      recommendations: ['Practice graph traversal'],
    });

    // A later conversation: discover everything from scratch.
    const found = (await data('list_candidates')).candidates;
    expect(found).toHaveLength(1);
    const interviews = (await data('list_interviews', { candidate_id: found[0].candidate_id })).interviews;
    expect(interviews).toMatchObject([{ interview_id: interview.interview_id, status: 'completed' }]);
    const context = await data('get_interview_context', { interview_id: interviews[0].interview_id });
    expect(context.candidate).toMatchObject({ name: 'Val', skill_assessment: { graphs: { score: 6 } } });
    expect(context.job).toMatchObject({ company: 'Palantir' });
    expect(context.interview).toMatchObject({ status: 'completed', overall_score: 7.2 });
    expect(context.previous_events.map((e: { type: string }) => e.type)).toEqual([
      'question_asked',
      'question_answered',
    ]);
    expect(context.skill_history.history).toHaveLength(1);
  });

  it('returns a failed call as an envelope with isError set', async () => {
    const { isError, envelope } = await call('get_candidate_profile', { candidate_id: 'cand_missing' });
    expect(isError).toBe(true);
    expect(envelope).toEqual({
      success: false,
      error: {
        code: 'CANDIDATE_NOT_FOUND',
        message: "Candidate 'cand_missing' does not exist.",
        field: 'candidate_id',
        retryable: false,
      },
    });
  });

  it('returns invalid arguments as an envelope, not a protocol error', async () => {
    const { isError, envelope } = await call('create_candidate', { name: 'Val', nickname: 'V' });
    expect(isError).toBe(true);
    expect(envelope.error).toMatchObject({ code: 'INVALID_FIELD', field: 'nickname' });
  });

  it('handles a call with no arguments', async () => {
    const { isError, envelope } = await call('get_candidate_profile');
    expect(isError).toBe(true);
    expect(envelope.error).toMatchObject({ code: 'INVALID_ID', field: 'candidate_id' });
    expect((await data('list_candidates')).candidates).toEqual([]);
  });

  it('returns an unknown tool as an envelope', async () => {
    const { isError, envelope } = await call('delete_everything', {});
    expect(isError).toBe(true);
    expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', retryable: false });
    expect(envelope.error.message).toContain('delete_everything');
  });
});

describe('logging', () => {
  it('logs one line per call with outcome and no private content', async () => {
    await call('create_candidate', { name: 'Val', resume: 'SECRET-RESUME-TEXT' });
    await call('get_candidate_profile', { candidate_id: 'cand_missing' });

    expect(logged).toHaveLength(2);
    expect(JSON.parse(logged[0] ?? '')).toEqual({ tool: 'create_candidate', ok: true, ms: expect.any(Number) });
    expect(JSON.parse(logged[1] ?? '')).toEqual({
      tool: 'get_candidate_profile',
      ok: false,
      code: 'CANDIDATE_NOT_FOUND',
      ms: expect.any(Number),
    });
    expect(logged.join('\n')).not.toContain('SECRET-RESUME-TEXT');
    expect(logged.join('\n')).not.toContain('Val');
  });
});
