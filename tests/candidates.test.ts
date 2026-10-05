import { describe, expect, it } from 'vitest';
import { advance, fail, ok, useDb } from './helpers.js';

const getDb = useDb();

describe('create_candidate', () => {
  it('creates a candidate with defaults', () => {
    const profile = ok(getDb(), 'create_candidate', { name: 'Val' });
    expect(profile).toEqual({
      candidate_id: expect.stringMatching(/^cand_[0-9a-f]{16}$/),
      name: 'Val',
      version: 1,
      resume: '',
      experience: [],
      projects: [],
      skills: [],
      interests: [],
      preferences: [],
      skill_assessment: {},
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    });
  });

  it('stores the supplied profile', () => {
    const input = {
      name: 'Val',
      resume: 'Resume text',
      experience: [{ title: 'Intern', organization: 'Acme', start: '2025-06', description: 'Built APIs' }],
      projects: [{ name: 'Mohr', description: 'MCP server', technologies: ['TypeScript'], url: 'https://x.dev' }],
      skills: ['Rust', 'Go'],
      interests: ['distributed systems'],
      preferences: ['prefers hints late'],
    };
    const created = ok(getDb(), 'create_candidate', input);
    expect(created).toMatchObject(input);
    expect(ok(getDb(), 'get_candidate_profile', { candidate_id: created.candidate_id })).toEqual(created);
  });

  it('rejects a name that differs only by case or surrounding whitespace', () => {
    const first = ok(getDb(), 'create_candidate', { name: 'Val' });
    const error = fail(getDb(), 'create_candidate', { name: '  val ' });
    expect(error).toMatchObject({ code: 'DUPLICATE_RESOURCE', field: 'name', retryable: false });
    expect(error.message).toContain(first.candidate_id);
    expect(ok(getDb(), 'list_candidates').candidates).toHaveLength(1);
  });

  it('rejects a whitespace-only name', () => {
    expect(fail(getDb(), 'create_candidate', { name: '   ' })).toMatchObject({
      code: 'INVALID_INPUT',
      field: 'name',
    });
    expect(ok(getDb(), 'list_candidates').candidates).toEqual([]);
  });

  it('accepts a resume of exactly 100000 characters and rejects one longer', () => {
    ok(getDb(), 'create_candidate', { name: 'A', resume: 'x'.repeat(100_000) });
    expect(fail(getDb(), 'create_candidate', { name: 'B', resume: 'x'.repeat(100_001) })).toMatchObject({
      code: 'INVALID_INPUT',
      field: 'resume',
    });
  });

  it('rejects an unknown key inside a structured field', () => {
    expect(
      fail(getDb(), 'create_candidate', {
        name: 'Val',
        experience: [{ title: 'Intern', organization: 'Acme', salary: 1 }],
      }),
    ).toMatchObject({ code: 'INVALID_FIELD', field: 'experience.0.salary' });
  });
});

describe('get_candidate_profile', () => {
  it('fails for an unknown candidate', () => {
    expect(fail(getDb(), 'get_candidate_profile', { candidate_id: 'cand_missing' })).toEqual({
      code: 'CANDIDATE_NOT_FOUND',
      message: "Candidate 'cand_missing' does not exist.",
      field: 'candidate_id',
      retryable: false,
    });
  });

  it('rejects an empty id', () => {
    expect(fail(getDb(), 'get_candidate_profile', { candidate_id: '' })).toMatchObject({
      code: 'INVALID_ID',
      field: 'candidate_id',
    });
  });
});

describe('update_candidate_profile', () => {
  it('replaces supplied fields whole, keeps the rest, and bumps version', () => {
    const created = ok(getDb(), 'create_candidate', {
      name: 'Val',
      resume: 'v1',
      skills: ['Rust', 'Go'],
      interests: ['compilers'],
    });
    advance();
    const updated = ok(getDb(), 'update_candidate_profile', {
      candidate_id: created.candidate_id,
      updates: { skills: ['Python'], resume: 'v2' },
    });
    expect(updated).toMatchObject({
      name: 'Val',
      resume: 'v2',
      skills: ['Python'],
      interests: ['compilers'],
      version: 2,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:01.000Z',
    });
  });

  it('can clear a list by sending an empty array', () => {
    const created = ok(getDb(), 'create_candidate', { name: 'Val', skills: ['Rust'] });
    const updated = ok(getDb(), 'update_candidate_profile', {
      candidate_id: created.candidate_id,
      updates: { skills: [] },
    });
    expect(updated.skills).toEqual([]);
  });

  it('rejects a string where an array is required and changes nothing', () => {
    const created = ok(getDb(), 'create_candidate', { name: 'Val', skills: ['Go'] });
    expect(
      fail(getDb(), 'update_candidate_profile', {
        candidate_id: created.candidate_id,
        updates: { skills: 'Rust' },
      }),
    ).toMatchObject({ code: 'INVALID_FIELD_TYPE', field: 'updates.skills' });
    expect(ok(getDb(), 'get_candidate_profile', { candidate_id: created.candidate_id })).toEqual(created);
  });

  it('rejects an unknown field', () => {
    const created = ok(getDb(), 'create_candidate', { name: 'Val' });
    expect(
      fail(getDb(), 'update_candidate_profile', { candidate_id: created.candidate_id, updates: { age: 30 } }),
    ).toMatchObject({ code: 'INVALID_FIELD', field: 'updates.age' });
  });

  it('rejects empty updates', () => {
    const created = ok(getDb(), 'create_candidate', { name: 'Val' });
    expect(
      fail(getDb(), 'update_candidate_profile', { candidate_id: created.candidate_id, updates: {} }),
    ).toMatchObject({ code: 'INVALID_INPUT', field: 'updates' });
  });

  it('fails for an unknown candidate', () => {
    expect(
      fail(getDb(), 'update_candidate_profile', { candidate_id: 'cand_missing', updates: { skills: [] } }),
    ).toMatchObject({ code: 'CANDIDATE_NOT_FOUND', field: 'candidate_id' });
  });

  it('rejects renaming to a name another candidate uses, and changes nothing', () => {
    ok(getDb(), 'create_candidate', { name: 'Val' });
    const other = ok(getDb(), 'create_candidate', { name: 'Sam' });
    expect(
      fail(getDb(), 'update_candidate_profile', {
        candidate_id: other.candidate_id,
        updates: { name: 'VAL', skills: ['Go'] },
      }),
    ).toMatchObject({ code: 'DUPLICATE_RESOURCE', field: 'updates.name' });
    expect(ok(getDb(), 'get_candidate_profile', { candidate_id: other.candidate_id })).toEqual(other);
  });

  it("allows changing the case of the candidate's own name", () => {
    const created = ok(getDb(), 'create_candidate', { name: 'val' });
    const updated = ok(getDb(), 'update_candidate_profile', {
      candidate_id: created.candidate_id,
      updates: { name: 'Val' },
    });
    expect(updated.name).toBe('Val');
  });
});

describe('list_candidates', () => {
  it('lists summaries, most recently updated first, without profile content', () => {
    const a = ok(getDb(), 'create_candidate', { name: 'A', resume: 'SECRET' });
    advance();
    const b = ok(getDb(), 'create_candidate', { name: 'B' });
    advance();
    ok(getDb(), 'update_candidate_profile', { candidate_id: a.candidate_id, updates: { skills: ['Go'] } });

    expect(ok(getDb(), 'list_candidates')).toEqual({
      candidates: [
        {
          candidate_id: a.candidate_id,
          name: 'A',
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:02.000Z',
        },
        {
          candidate_id: b.candidate_id,
          name: 'B',
          created_at: '2026-01-01T00:00:01.000Z',
          updated_at: '2026-01-01T00:00:01.000Z',
        },
      ],
    });
  });

  it('rejects unexpected arguments', () => {
    expect(fail(getDb(), 'list_candidates', { limit: 5 })).toMatchObject({ code: 'INVALID_FIELD', field: 'limit' });
  });
});
