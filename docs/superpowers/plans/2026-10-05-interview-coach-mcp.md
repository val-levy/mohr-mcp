# Interview Coach MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local stdio MCP server exposing 13 tools that persist candidates, target jobs, interviews, interview events and skill assessments in SQLite, so Claude can act as a technical interviewer with memory.

**Architecture:** Each tool is a strict zod schema plus a plain handler `(db, input) => data` that throws `CoachError`. One function, `callTool`, parses raw arguments, runs the handler and converts the outcome into a `{success, data | error}` envelope; `server.ts` is the only file that touches the MCP protocol. All writes run inside `BEGIN IMMEDIATE` transactions on a single `better-sqlite3` connection.

**Tech Stack:** TypeScript (ESM, NodeNext), Node 24, `@modelcontextprotocol/sdk` 1.x (low-level `Server`), `zod` 4.x, `better-sqlite3`, `vitest`, npm.

**Spec:** `docs/superpowers/specs/2026-10-05-interview-coach-mcp-design.md`

## Global Constraints

- Package name `interview-coach-mcp`; MCP server name `interview-coach`; version `0.1.0`.
- Node `>=24`. Dependencies pinned by major: `@modelcontextprotocol/sdk@^1`, `zod@^4`. Use npm, not pnpm (pnpm skips the `better-sqlite3` install script by default).
- ESM only: `"type": "module"`, relative imports end in `.js`.
- Every tool input is a `z.strictObject`; unknown keys are rejected at every nesting level except inside `metadata`.
- Every tool response is one text block containing `{"success":true,"data":…}` or `{"success":false,"error":{code,message,field?,retryable}}`; failures also set `isError: true`.
- Validation happens in `callTool`, never in the SDK. Do not use `McpServer.registerTool` with an input schema.
- IDs are server-generated: `cand_`, `job_`, `int_` plus 16 hex characters. Timestamps are `new Date().toISOString()`.
- Limits: resume at most 100,000 characters; serialized event at most 50,000 characters; scores 0–10; confidence 0–1.
- Interview types: `technical`, `behavioral`, `system_design`. Interview statuses: `active`, `completed`.
- Event types: `question_asked`, `question_answered`, `hint_requested`, `hint_given`, `follow_up`, `evaluation`, `topic_completed`.
- Only `STORAGE_UNAVAILABLE` is retryable.
- Write ownership (spec section 6): `record_interview_event` and `finish_interview` never touch `skill_assessments` or `skill_assessment_history`.
- Logging goes to stderr only and contains at most tool name, success flag, error code and duration. Never log arguments or results.
- Database path: `COACH_DB_PATH` if set, else `~/.interview-coach/coach.db`.
- Tests call tools through `callTool` on a fresh `:memory:` database. No test may touch `~/.interview-coach`.
- End every commit message with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

One file beyond the spec's layout: `src/tool.ts` holds `Tool`, `defineTool` and `callTool`, so tool modules and `server.ts` can both import them without a cycle. `src/tools/index.ts` holds the registry.

## Review Focus

Inputs the spec implies but does not spell out as tests. Each has a test in the task named.

1. A tool called with no arguments at all (`arguments` undefined or null) returns a normal error envelope naming the first missing field, never a crash or a protocol error. (Task 2, Task 8)
2. A candidate name that differs from an existing one only by case or surrounding whitespace (`"Val"` then `" val "`) is a duplicate; a whitespace-only name is rejected rather than stored blank. (Task 3)
3. Starting the server twice against the same database file keeps the data, and a database path whose parent directories do not exist is created rather than failing. (Task 1)
4. Answer text is stored byte-for-byte: leading indentation, newlines, quotes and non-ASCII characters in a code answer come back unchanged. (Task 5, Task 7)
5. Boundary numbers: scores of exactly 0 and 10 and confidence of exactly 0 and 1 are accepted; a numeric string such as `"7"` is rejected rather than coerced. (Task 6)

## File Map

| File | Responsibility | Task |
|---|---|---|
| `package.json`, `tsconfig.json`, `tsconfig.build.json`, `.gitignore` | Project scaffold | 1 |
| `src/db.ts` | Open database, schema, `tx`, `newId`, `now` | 1 |
| `src/errors.ts` | Error codes, `CoachError`, zod and SQLite error mapping | 2 |
| `src/tool.ts` | `Tool`, `defineTool`, `callTool`, `Envelope` | 2 |
| `src/schemas.ts` | All zod input schemas | 3–7 |
| `src/tools/candidates.ts` | 4 candidate tools, `loadProfile`, `requireCandidate` | 3 |
| `src/tools/index.ts` | `tools` registry | 3–7 |
| `src/tools/jobs.ts` | 3 job tools, `loadJob` | 4 |
| `src/tools/interviews.ts` | 5 interview tools, `loadInterview` | 5, 7 |
| `src/tools/skills.ts` | `update_skill_assessment` | 6 |
| `src/server.ts` | `buildServer`: protocol wiring, logging, instructions | 8 |
| `src/index.ts` | stdio entry point | 8 |
| `README.md` | Build, register, configure | 8 |
| `tests/helpers.ts` | `useDb`, `advance`, `call`, `ok`, `fail` | 3 |
| `tests/*.test.ts` | One file per task | 1–8 |

---

### Task 1: Project scaffold and database layer

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `.gitignore`
- Create: `src/db.ts`
- Test: `tests/db.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces, from `src/db.ts`:
  - `type Db` (a `better-sqlite3` database)
  - `openDb(path: string): Db` — creates parent directories, sets pragmas, creates schema if missing
  - `defaultDbPath(): string`
  - `tx<T>(db: Db, fn: () => T): T` — runs `fn` in a `BEGIN IMMEDIATE` transaction, rolls back if it throws
  - `newId(prefix: 'cand' | 'job' | 'int'): string`
  - `now(): string`
  - Tables `candidates`, `jobs`, `interviews`, `interview_events`, `skill_assessments`, `skill_assessment_history` with the columns in spec section 5.

- [ ] **Step 1: Create the scaffold files**

`package.json`:

```json
{
  "name": "interview-coach-mcp",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": { "interview-coach-mcp": "dist/index.js" },
  "engines": { "node": ">=24" },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "start": "node dist/index.js"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "tests"]
}
```

`tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": false, "rootDir": "src", "outDir": "dist" },
  "include": ["src"]
}
```

`.gitignore`:

```
node_modules/
dist/
*.db
*.db-wal
*.db-shm
```

- [ ] **Step 2: Install dependencies**

```bash
npm install @modelcontextprotocol/sdk@^1 zod@^4 better-sqlite3
npm install -D typescript vitest @types/node@^24 @types/better-sqlite3
```

Expected: both commands finish without errors and `node_modules/better-sqlite3/build/Release/better_sqlite3.node` exists.

- [ ] **Step 3: Write the failing test**

`tests/db.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type Db, defaultDbPath, newId, now, openDb, tx } from '../src/db.js';

function seedEvent(db: Db): void {
  const t = now();
  db.prepare(
    "INSERT INTO candidates (id, name, profile, created_at, updated_at) VALUES ('cand_1', 'Val', '{}', ?, ?)",
  ).run(t, t);
  db.prepare(
    "INSERT INTO jobs (id, candidate_id, company, title, description, requirements, metadata, created_at) VALUES ('job_1', 'cand_1', 'Acme', 'SWE', 'Build things', '[]', '{}', ?)",
  ).run(t);
  db.prepare(
    "INSERT INTO interviews (id, candidate_id, job_id, type, status, started_at) VALUES ('int_1', 'cand_1', 'job_1', 'technical', 'active', ?)",
  ).run(t);
  db.prepare(
    "INSERT INTO interview_events (interview_id, type, data, created_at) VALUES ('int_1', 'question_asked', '{}', ?)",
  ).run(t);
}

describe('openDb', () => {
  it('creates all six tables', () => {
    const db = openDb(':memory:');
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(names).toEqual([
      'candidates',
      'interview_events',
      'interviews',
      'jobs',
      'skill_assessment_history',
      'skill_assessments',
    ]);
    db.close();
  });

  it('enforces foreign keys', () => {
    const db = openDb(':memory:');
    expect(() =>
      db
        .prepare(
          "INSERT INTO jobs (id, candidate_id, company, title, description, requirements, metadata, created_at) VALUES ('job_1', 'cand_missing', 'Acme', 'SWE', 'x', '[]', '{}', 't')",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
    db.close();
  });

  it('rejects any status other than active or completed', () => {
    const db = openDb(':memory:');
    seedEvent(db);
    expect(() => db.prepare("UPDATE interviews SET status = 'created'").run()).toThrow(/CHECK/);
    db.close();
  });

  it('makes interview_events append-only', () => {
    const db = openDb(':memory:');
    seedEvent(db);
    expect(() => db.prepare("UPDATE interview_events SET type = 'evaluation'").run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM interview_events').run()).toThrow(/append-only/);
    expect(db.prepare('SELECT type FROM interview_events').all()).toEqual([{ type: 'question_asked' }]);
    db.close();
  });
});

describe('openDb on disk', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('creates missing parent directories and keeps data when reopened', () => {
    dir = mkdtempSync(join(tmpdir(), 'coach-'));
    const path = join(dir, 'nested', 'deeper', 'coach.db');
    const first = openDb(path);
    seedEvent(first);
    first.close();

    const second = openDb(path);
    expect(second.prepare('SELECT name FROM candidates').all()).toEqual([{ name: 'Val' }]);
    expect(second.prepare('SELECT count(*) AS n FROM interview_events').get()).toEqual({ n: 1 });
    second.close();
  });
});

describe('defaultDbPath', () => {
  afterEach(() => {
    delete process.env.COACH_DB_PATH;
  });

  it('uses COACH_DB_PATH when set', () => {
    process.env.COACH_DB_PATH = '/tmp/custom/coach.db';
    expect(defaultDbPath()).toBe('/tmp/custom/coach.db');
  });

  it('falls back to ~/.interview-coach/coach.db', () => {
    delete process.env.COACH_DB_PATH;
    expect(defaultDbPath()).toMatch(/\.interview-coach[/\\]coach\.db$/);
  });
});

describe('tx', () => {
  it('returns the callback result and commits', () => {
    const db = openDb(':memory:');
    const result = tx(db, () => {
      seedEvent(db);
      return 42;
    });
    expect(result).toBe(42);
    expect(db.prepare('SELECT count(*) AS n FROM candidates').get()).toEqual({ n: 1 });
    db.close();
  });

  it('rolls everything back when the callback throws', () => {
    const db = openDb(':memory:');
    expect(() =>
      tx(db, () => {
        seedEvent(db);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(db.prepare('SELECT count(*) AS n FROM candidates').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM interview_events').get()).toEqual({ n: 0 });
    db.close();
  });
});

describe('newId', () => {
  it('produces a prefixed 16-hex-character id', () => {
    expect(newId('cand')).toMatch(/^cand_[0-9a-f]{16}$/);
    expect(newId('job')).toMatch(/^job_[0-9a-f]{16}$/);
    expect(newId('int')).toMatch(/^int_[0-9a-f]{16}$/);
    expect(newId('int')).not.toBe(newId('int'));
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run tests/db.test.ts`
Expected: FAIL, cannot resolve `../src/db.js`.

- [ ] **Step 5: Write the implementation**

`src/db.ts`:

```ts
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';

export type Db = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS candidates (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL COLLATE NOCASE UNIQUE,
  resume      TEXT NOT NULL DEFAULT '',
  profile     TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,
  candidate_id  TEXT NOT NULL REFERENCES candidates(id),
  company       TEXT NOT NULL,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL,
  location      TEXT,
  requirements  TEXT NOT NULL,
  metadata      TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_by_candidate ON jobs(candidate_id);

CREATE TABLE IF NOT EXISTS interviews (
  id                TEXT PRIMARY KEY,
  candidate_id      TEXT NOT NULL REFERENCES candidates(id),
  job_id            TEXT NOT NULL REFERENCES jobs(id),
  type              TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('active', 'completed')),
  started_at        TEXT NOT NULL,
  finished_at       TEXT,
  overall_score     REAL,
  final_evaluation  TEXT
);
CREATE INDEX IF NOT EXISTS interviews_by_candidate ON interviews(candidate_id);

CREATE TABLE IF NOT EXISTS interview_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  interview_id  TEXT NOT NULL REFERENCES interviews(id),
  type          TEXT NOT NULL,
  data          TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_by_interview ON interview_events(interview_id);

CREATE TRIGGER IF NOT EXISTS interview_events_no_update
BEFORE UPDATE ON interview_events
BEGIN
  SELECT RAISE(ABORT, 'interview_events is append-only');
END;

CREATE TRIGGER IF NOT EXISTS interview_events_no_delete
BEFORE DELETE ON interview_events
BEGIN
  SELECT RAISE(ABORT, 'interview_events is append-only');
END;

CREATE TABLE IF NOT EXISTS skill_assessments (
  candidate_id  TEXT NOT NULL REFERENCES candidates(id),
  skill         TEXT NOT NULL,
  score         REAL NOT NULL,
  confidence    REAL NOT NULL,
  evidence      TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (candidate_id, skill)
);

CREATE TABLE IF NOT EXISTS skill_assessment_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id  TEXT NOT NULL REFERENCES candidates(id),
  skill         TEXT NOT NULL,
  score         REAL NOT NULL,
  confidence    REAL NOT NULL,
  evidence      TEXT NOT NULL,
  interview_id  TEXT REFERENCES interviews(id),
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS skill_history_by_candidate ON skill_assessment_history(candidate_id);
`;

export function defaultDbPath(): string {
  return process.env.COACH_DB_PATH || join(homedir(), '.interview-coach', 'coach.db');
}

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  return db;
}

export function tx<T>(db: Db, fn: () => T): T {
  return db.transaction(fn).immediate();
}

export function newId(prefix: 'cand' | 'job' | 'int'): string {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

export function now(): string {
  return new Date().toISOString();
}
```

- [ ] **Step 6: Run the test and the typecheck**

Run: `npx vitest run tests/db.test.ts && npm run typecheck`
Expected: all tests PASS, typecheck prints nothing.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json tsconfig.build.json .gitignore src/db.ts tests/db.test.ts
git commit -m "Add project scaffold and SQLite database layer"
```

---

### Task 2: Errors and the tool envelope

**Files:**
- Create: `src/errors.ts`, `src/tool.ts`
- Test: `tests/envelope.test.ts`

**Interfaces:**
- Consumes: `Db` from `src/db.ts`.
- Produces, from `src/errors.ts`:
  - `type ErrorCode` — the 19 codes below
  - `interface ErrorBody { code: ErrorCode; message: string; field?: string; retryable: boolean }`
  - `class CoachError extends Error` with `new CoachError(code: ErrorCode, message: string, field?: string)`
  - `fromZodError(error: z.ZodError, raw: unknown): CoachError`
  - `toErrorBody(err: unknown): ErrorBody`
- Produces, from `src/tool.ts`:
  - `type Envelope = { success: true; data: unknown } | { success: false; error: ErrorBody }`
  - `interface Tool { name: string; description: string; schema: z.ZodType; run(db: Db, input: unknown): unknown }`
  - `defineTool({ name, description, schema, handler }): Tool` where `handler: (db: Db, input: z.output<typeof schema>) => unknown`
  - `callTool(db: Db, tool: Tool, rawArgs: unknown): Envelope`

How zod 4 reports problems, which the mapping relies on: a missing or wrongly typed field is `invalid_type`; a bad enum value (including a missing one) is `invalid_value`; unknown keys are one `unrecognized_keys` issue whose `path` is the containing object and whose `keys` lists the names, reported after the property issues; `NaN` and `Infinity` are `invalid_type`. Issue messages describe the expected type and never echo the input value.

- [ ] **Step 1: Write the failing test**

`tests/envelope.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type Db, openDb } from '../src/db.js';
import { CoachError } from '../src/errors.js';
import { callTool, defineTool } from '../src/tool.js';

const probe = defineTool({
  name: 'probe',
  description: 'Test-only tool.',
  schema: z.strictObject({
    thing_id: z.string().trim().min(1),
    label: z.string().trim().min(1),
    tags: z.array(z.string()).optional(),
    score: z.number().min(0).max(10).optional(),
    overall_score: z.number().min(0).max(10).optional(),
    category_scores: z.record(z.string(), z.number().min(0).max(10)).optional(),
    confidence: z.number().min(0).max(1).optional(),
    interview_type: z.enum(['technical']).optional(),
    event: z.strictObject({ type: z.enum(['question_asked']) }).optional(),
    mode: z.enum(['ok', 'coach', 'busy', 'constraint', 'boom']).default('ok'),
  }),
  handler: (_db, input) => {
    if (input.mode === 'coach') throw new CoachError('INTERVIEW_NOT_ACTIVE', 'Interview is not active.', 'thing_id');
    if (input.mode === 'busy') throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    if (input.mode === 'constraint') {
      throw Object.assign(new Error('UNIQUE constraint failed: secret_table.col'), {
        code: 'SQLITE_CONSTRAINT_UNIQUE',
      });
    }
    if (input.mode === 'boom') throw new Error('secret detail at /Users/val/private');
    return { echoed: input.label };
  },
});

const base = { thing_id: 't_1', label: 'hello' };

let db: Db;
beforeEach(() => {
  db = openDb(':memory:');
});
afterEach(() => {
  db.close();
});

function error(args: unknown) {
  const env = callTool(db, probe, args);
  if (env.success) throw new Error('expected failure');
  return env.error;
}

describe('callTool success', () => {
  it('returns the handler result as data, with parsed input', () => {
    expect(callTool(db, probe, { thing_id: 't_1', label: '  hello  ' })).toEqual({
      success: true,
      data: { echoed: 'hello' },
    });
  });
});

describe('callTool validation errors', () => {
  it('reports an unknown key as INVALID_FIELD', () => {
    expect(error({ ...base, zzz: 1 })).toEqual({
      code: 'INVALID_FIELD',
      message: "Unknown field 'zzz'.",
      field: 'zzz',
      retryable: false,
    });
  });

  it('reports a nested unknown key with a dotted path', () => {
    expect(error({ ...base, event: { type: 'question_asked', extra: 1 } })).toMatchObject({
      code: 'INVALID_FIELD',
      field: 'event.extra',
    });
  });

  it('reports a wrong type as INVALID_FIELD_TYPE', () => {
    expect(error({ ...base, tags: 'rust' })).toMatchObject({ code: 'INVALID_FIELD_TYPE', field: 'tags' });
  });

  it('reports a missing required field as INVALID_INPUT', () => {
    expect(error({ thing_id: 't_1' })).toMatchObject({ code: 'INVALID_INPUT', field: 'label' });
  });

  it('reports an empty required string as INVALID_INPUT', () => {
    expect(error({ thing_id: 't_1', label: '   ' })).toMatchObject({ code: 'INVALID_INPUT', field: 'label' });
  });

  it.each([[undefined], [''], ['   '], [5], [null]])('reports id %j as INVALID_ID', (value) => {
    expect(error({ label: 'hello', thing_id: value })).toMatchObject({ code: 'INVALID_ID', field: 'thing_id' });
  });

  it.each([[11], [-1], [Number.NaN], [Number.POSITIVE_INFINITY], ['7']])(
    'reports score %j as INVALID_SCORE',
    (value) => {
      expect(error({ ...base, score: value })).toMatchObject({ code: 'INVALID_SCORE', field: 'score' });
      expect(error({ ...base, overall_score: value })).toMatchObject({
        code: 'INVALID_SCORE',
        field: 'overall_score',
      });
      expect(error({ ...base, category_scores: { algorithms: value } })).toMatchObject({
        code: 'INVALID_SCORE',
        field: 'category_scores.algorithms',
      });
    },
  );

  it('reports a non-object category_scores as INVALID_FIELD_TYPE, not INVALID_SCORE', () => {
    expect(error({ ...base, category_scores: 7 })).toMatchObject({
      code: 'INVALID_FIELD_TYPE',
      field: 'category_scores',
    });
  });

  it.each([[1.5], [-0.1], [Number.NaN], ['0.5']])('reports confidence %j as INVALID_CONFIDENCE', (value) => {
    expect(error({ ...base, confidence: value })).toMatchObject({
      code: 'INVALID_CONFIDENCE',
      field: 'confidence',
    });
  });

  it('reports an unknown or missing event type as INVALID_EVENT_TYPE', () => {
    expect(error({ ...base, event: { type: 'made_up' } })).toMatchObject({
      code: 'INVALID_EVENT_TYPE',
      field: 'event.type',
    });
    expect(error({ ...base, event: {} })).toMatchObject({ code: 'INVALID_EVENT_TYPE', field: 'event.type' });
  });

  it('reports an unknown interview type as INVALID_INTERVIEW_TYPE', () => {
    expect(error({ ...base, interview_type: 'vibes' })).toMatchObject({
      code: 'INVALID_INTERVIEW_TYPE',
      field: 'interview_type',
    });
  });

  it('reports the first problem when there are several', () => {
    expect(error({ thing_id: '', label: 5, zzz: 1 })).toMatchObject({ code: 'INVALID_ID', field: 'thing_id' });
  });

  it.each([[undefined], [null]])('treats arguments %j as an empty object', (args) => {
    expect(error(args)).toMatchObject({ code: 'INVALID_ID', field: 'thing_id', retryable: false });
  });

  it('never echoes input values in the message', () => {
    const message = error({ ...base, tags: 'SECRET-VALUE' }).message;
    expect(message).not.toContain('SECRET-VALUE');
  });
});

describe('callTool handler errors', () => {
  it('passes a CoachError through', () => {
    expect(error({ ...base, mode: 'coach' })).toEqual({
      code: 'INTERVIEW_NOT_ACTIVE',
      message: 'Interview is not active.',
      field: 'thing_id',
      retryable: false,
    });
  });

  it('maps SQLite busy to a retryable STORAGE_UNAVAILABLE', () => {
    expect(error({ ...base, mode: 'busy' })).toEqual({
      code: 'STORAGE_UNAVAILABLE',
      message: 'Storage is temporarily unavailable. Retrying may succeed.',
      retryable: true,
    });
  });

  it('maps other SQLite errors to DATABASE_ERROR without leaking details', () => {
    const body = error({ ...base, mode: 'constraint' });
    expect(body).toEqual({
      code: 'DATABASE_ERROR',
      message: 'A database error occurred. The operation was not applied.',
      retryable: false,
    });
    expect(body.message).not.toContain('secret_table');
  });

  it('maps anything else to INTERNAL_ERROR without leaking details', () => {
    const body = error({ ...base, mode: 'boom' });
    expect(body).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'An unexpected internal error occurred.',
      retryable: false,
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/envelope.test.ts`
Expected: FAIL, cannot resolve `../src/errors.js`.

- [ ] **Step 3: Write `src/errors.ts`**

```ts
import type { z } from 'zod';

export const ERROR_CODES = [
  'INVALID_INPUT',
  'INVALID_FIELD',
  'INVALID_FIELD_TYPE',
  'INVALID_ID',
  'CANDIDATE_NOT_FOUND',
  'JOB_NOT_FOUND',
  'INTERVIEW_NOT_FOUND',
  'INTERVIEW_NOT_ACTIVE',
  'INTERVIEW_ALREADY_COMPLETED',
  'INVALID_EVENT_TYPE',
  'INVALID_INTERVIEW_TYPE',
  'INVALID_SCORE',
  'INVALID_CONFIDENCE',
  'DUPLICATE_RESOURCE',
  'CONFLICT',
  'DATABASE_ERROR',
  'STORAGE_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorBody {
  code: ErrorCode;
  message: string;
  field?: string;
  retryable: boolean;
}

const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['STORAGE_UNAVAILABLE']);

export class CoachError extends Error {
  readonly code: ErrorCode;
  readonly field?: string;

  constructor(code: ErrorCode, message: string, field?: string) {
    super(message);
    this.name = 'CoachError';
    this.code = code;
    if (field !== undefined) this.field = field;
  }
}

type Issue = z.ZodError['issues'][number];

function valueAt(raw: unknown, path: readonly PropertyKey[]): unknown {
  let current = raw;
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<PropertyKey, unknown>)[key];
  }
  return current;
}

function classify(issue: Issue, raw: unknown): ErrorCode {
  const path = issue.path;
  const last = path[path.length - 1];
  if (typeof last === 'string' && last.endsWith('_id')) return 'INVALID_ID';
  if (last === 'score' || last === 'overall_score') return 'INVALID_SCORE';
  if (path.length === 2 && path[0] === 'category_scores') return 'INVALID_SCORE';
  if (last === 'confidence') return 'INVALID_CONFIDENCE';
  if (path.length === 2 && path[0] === 'event' && last === 'type') return 'INVALID_EVENT_TYPE';
  if (last === 'interview_type') return 'INVALID_INTERVIEW_TYPE';
  if (issue.code === 'invalid_type' && valueAt(raw, path) !== undefined) return 'INVALID_FIELD_TYPE';
  return 'INVALID_INPUT';
}

export function fromZodError(error: z.ZodError, raw: unknown): CoachError {
  const issue = error.issues[0];
  if (issue === undefined) return new CoachError('INVALID_INPUT', 'Invalid input.');
  if (issue.code === 'unrecognized_keys') {
    const field = [...issue.path, issue.keys[0]].map(String).join('.');
    return new CoachError('INVALID_FIELD', `Unknown field '${field}'.`, field);
  }
  const field = issue.path.map(String).join('.');
  const where = field === '' ? 'input' : `'${field}'`;
  return new CoachError(classify(issue, raw), `Invalid ${where}: ${issue.message}`, field === '' ? undefined : field);
}

function sqliteCode(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && code.startsWith('SQLITE_') ? code : undefined;
}

export function toErrorBody(err: unknown): ErrorBody {
  if (err instanceof CoachError) {
    return {
      code: err.code,
      message: err.message,
      ...(err.field !== undefined ? { field: err.field } : {}),
      retryable: RETRYABLE.has(err.code),
    };
  }
  const code = sqliteCode(err);
  if (code !== undefined) {
    if (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED')) {
      return {
        code: 'STORAGE_UNAVAILABLE',
        message: 'Storage is temporarily unavailable. Retrying may succeed.',
        retryable: true,
      };
    }
    return {
      code: 'DATABASE_ERROR',
      message: 'A database error occurred. The operation was not applied.',
      retryable: false,
    };
  }
  return { code: 'INTERNAL_ERROR', message: 'An unexpected internal error occurred.', retryable: false };
}
```

- [ ] **Step 4: Write `src/tool.ts`**

```ts
import type { z } from 'zod';
import type { Db } from './db.js';
import { type ErrorBody, fromZodError, toErrorBody } from './errors.js';

export type Envelope = { success: true; data: unknown } | { success: false; error: ErrorBody };

export interface Tool {
  name: string;
  description: string;
  schema: z.ZodType;
  run(db: Db, input: unknown): unknown;
}

export function defineTool<S extends z.ZodType>(def: {
  name: string;
  description: string;
  schema: S;
  handler: (db: Db, input: z.output<S>) => unknown;
}): Tool {
  return {
    name: def.name,
    description: def.description,
    schema: def.schema,
    run: (db, input) => def.handler(db, input as z.output<S>),
  };
}

export function callTool(db: Db, tool: Tool, rawArgs: unknown): Envelope {
  const args = rawArgs ?? {};
  try {
    const parsed = tool.schema.safeParse(args);
    if (!parsed.success) throw fromZodError(parsed.error, args);
    return { success: true, data: tool.run(db, parsed.data) };
  } catch (err) {
    return { success: false, error: toErrorBody(err) };
  }
}
```

- [ ] **Step 5: Run the test and the typecheck**

Run: `npx vitest run tests/envelope.test.ts && npm run typecheck`
Expected: all tests PASS, typecheck prints nothing.

- [ ] **Step 6: Commit**

```bash
git add src/errors.ts src/tool.ts tests/envelope.test.ts
git commit -m "Add error codes and the tool response envelope"
```

---

### Task 3: Candidate tools

**Files:**
- Create: `src/schemas.ts`, `src/tools/candidates.ts`, `src/tools/index.ts`
- Create: `tests/helpers.ts`
- Test: `tests/candidates.test.ts`

**Interfaces:**
- Consumes: `Db`, `newId`, `now`, `tx` from `src/db.ts`; `CoachError` from `src/errors.ts`; `defineTool`, `callTool`, `Tool`, `Envelope` from `src/tool.ts`.
- Produces, from `src/schemas.ts`: shared primitives `id`, `text`, `strings`, `score`, `confidence`; constants `RESUME_MAX`, `EVENT_MAX`, `INTERVIEW_TYPES`, `EVENT_TYPES`; schemas `createCandidateInput`, `getCandidateProfileInput`, `updateCandidateProfileInput`, `listCandidatesInput`.
- Produces, from `src/tools/candidates.ts`:
  - `requireCandidate(db: Db, candidateId: string): void` — throws `CANDIDATE_NOT_FOUND` with field `candidate_id`
  - `loadProfile(db: Db, candidateId: string)` — the full profile object of spec section 6, throws `CANDIDATE_NOT_FOUND`
  - `candidateTools: Tool[]`
- Produces, from `src/tools/index.ts`: `tools: Tool[]`.
- Produces, from `tests/helpers.ts`:
  - `useDb(): () => Db` — registers `beforeEach`/`afterEach`; fresh `:memory:` database, `Date` frozen at `2026-01-01T00:00:00.000Z`
  - `advance(ms = 1000): void` — moves the frozen clock forward
  - `call(db, name, args?): Envelope`
  - `ok(db, name, args?): any` — returns `data`, throws if the call failed
  - `fail(db, name, args?): ErrorBody` — returns `error`, throws if the call succeeded

- [ ] **Step 1: Write the test helpers**

`tests/helpers.ts`:

```ts
import { afterEach, beforeEach, vi } from 'vitest';
import { type Db, openDb } from '../src/db.js';
import type { ErrorBody } from '../src/errors.js';
import { type Envelope, callTool } from '../src/tool.js';
import { tools } from '../src/tools/index.js';

export function useDb(): () => Db {
  let db: Db;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    db = openDb(':memory:');
  });
  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });
  return () => db;
}

export function advance(ms = 1000): void {
  vi.setSystemTime(Date.now() + ms);
}

export function call(db: Db, name: string, args?: unknown): Envelope {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`No tool named '${name}' is registered.`);
  return callTool(db, tool, args);
}

// Returns `any` so tests can read fields of the result without casting.
export function ok(db: Db, name: string, args?: unknown): any {
  const env = call(db, name, args);
  if (!env.success) throw new Error(`${name} failed: ${env.error.code} ${env.error.message}`);
  return env.data;
}

export function fail(db: Db, name: string, args?: unknown): ErrorBody {
  const env = call(db, name, args);
  if (env.success) throw new Error(`${name} unexpectedly succeeded`);
  return env.error;
}
```

- [ ] **Step 2: Write the failing test**

`tests/candidates.test.ts`:

```ts
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

  it('allows changing the case of the candidate\'s own name', () => {
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/candidates.test.ts`
Expected: FAIL, cannot resolve `../src/tools/index.js`.

- [ ] **Step 4: Write `src/schemas.ts`**

`.trim()` and `.toLowerCase()` in zod 4 rewrite the value in place during parsing, so handlers receive the cleaned string.

```ts
import { z } from 'zod';

export const RESUME_MAX = 100_000;
export const EVENT_MAX = 50_000;
export const INTERVIEW_TYPES = ['technical', 'behavioral', 'system_design'] as const;
export const EVENT_TYPES = [
  'question_asked',
  'question_answered',
  'hint_requested',
  'hint_given',
  'follow_up',
  'evaluation',
  'topic_completed',
] as const;

export const id = z.string().trim().min(1);
export const text = z.string().trim().min(1);
export const strings = z.array(text);
export const score = z.number().min(0).max(10);
export const confidence = z.number().min(0).max(1);

const resume = z.string().max(RESUME_MAX);
const experience = z.array(
  z.strictObject({
    title: text,
    organization: text,
    start: text.optional(),
    end: text.optional(),
    description: text.optional(),
  }),
);
const projects = z.array(
  z.strictObject({
    name: text,
    description: text,
    technologies: strings.optional(),
    url: text.optional(),
  }),
);

export const createCandidateInput = z.strictObject({
  name: text,
  resume: resume.default(''),
  experience: experience.default([]),
  projects: projects.default([]),
  skills: strings.default([]),
  interests: strings.default([]),
  preferences: strings.default([]),
});

export const getCandidateProfileInput = z.strictObject({ candidate_id: id });

export const updateCandidateProfileInput = z.strictObject({
  candidate_id: id,
  updates: z
    .strictObject({
      name: text.optional(),
      resume: resume.optional(),
      experience: experience.optional(),
      projects: projects.optional(),
      skills: strings.optional(),
      interests: strings.optional(),
      preferences: strings.optional(),
    })
    .refine((updates) => Object.values(updates).some((value) => value !== undefined), {
      message: 'updates must contain at least one field',
    }),
});

export const listCandidatesInput = z.strictObject({});
```

- [ ] **Step 5: Write `src/tools/candidates.ts`**

```ts
import { type Db, newId, now, tx } from '../db.js';
import { CoachError } from '../errors.js';
import {
  createCandidateInput,
  getCandidateProfileInput,
  listCandidatesInput,
  updateCandidateProfileInput,
} from '../schemas.js';
import { type Tool, defineTool } from '../tool.js';

interface CandidateRow {
  id: string;
  name: string;
  resume: string;
  profile: string;
  version: number;
  created_at: string;
  updated_at: string;
}

interface Profile {
  experience: unknown[];
  projects: unknown[];
  skills: string[];
  interests: string[];
  preferences: string[];
}

interface SkillRow {
  skill: string;
  score: number;
  confidence: number;
  evidence: string;
  updated_at: string;
}

function findCandidate(db: Db, candidateId: string): CandidateRow {
  const row = db.prepare('SELECT * FROM candidates WHERE id = ?').get(candidateId) as CandidateRow | undefined;
  if (!row) {
    throw new CoachError('CANDIDATE_NOT_FOUND', `Candidate '${candidateId}' does not exist.`, 'candidate_id');
  }
  return row;
}

export function requireCandidate(db: Db, candidateId: string): void {
  findCandidate(db, candidateId);
}

export function loadProfile(db: Db, candidateId: string) {
  const row = findCandidate(db, candidateId);
  const skillRows = db
    .prepare(
      'SELECT skill, score, confidence, evidence, updated_at FROM skill_assessments WHERE candidate_id = ? ORDER BY skill',
    )
    .all(candidateId) as SkillRow[];
  const profile = JSON.parse(row.profile) as Profile;
  return {
    candidate_id: row.id,
    name: row.name,
    version: row.version,
    resume: row.resume,
    experience: profile.experience,
    projects: profile.projects,
    skills: profile.skills,
    interests: profile.interests,
    preferences: profile.preferences,
    skill_assessment: Object.fromEntries(skillRows.map(({ skill, ...rest }) => [skill, rest])),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// The name column is COLLATE NOCASE, so '=' ignores case.
function assertNameFree(db: Db, name: string, field: string, exceptId?: string): void {
  const clash = db.prepare('SELECT id FROM candidates WHERE name = ?').get(name) as { id: string } | undefined;
  if (clash && clash.id !== exceptId) {
    throw new CoachError(
      'DUPLICATE_RESOURCE',
      `A candidate named '${name}' already exists (candidate_id '${clash.id}').`,
      field,
    );
  }
}

const createCandidate = defineTool({
  name: 'create_candidate',
  description:
    'Create a new candidate. Call list_candidates first to check the person does not already exist. ' +
    'Names are unique ignoring case. Returns the full profile including the new candidate_id.',
  schema: createCandidateInput,
  handler: (db, input) =>
    tx(db, () => {
      assertNameFree(db, input.name, 'name');
      const { name, resume, ...profile } = input;
      const candidateId = newId('cand');
      const timestamp = now();
      db.prepare(
        'INSERT INTO candidates (id, name, resume, profile, version, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
      ).run(candidateId, name, resume, JSON.stringify(profile), timestamp, timestamp);
      return loadProfile(db, candidateId);
    }),
});

const getCandidateProfile = defineTool({
  name: 'get_candidate_profile',
  description:
    "Retrieve a candidate's persistent profile: resume, experience, projects, skills, interests, " +
    'preferences and the current skill assessment.',
  schema: getCandidateProfileInput,
  handler: (db, { candidate_id }) => loadProfile(db, candidate_id),
});

const updateCandidateProfile = defineTool({
  name: 'update_candidate_profile',
  description:
    'Persist changes to a candidate profile. Each field in updates REPLACES the stored value whole; ' +
    'arrays are not merged, so send the complete new list. Does not change skill scores; use ' +
    'update_skill_assessment for those.',
  schema: updateCandidateProfileInput,
  handler: (db, { candidate_id, updates }) =>
    tx(db, () => {
      const row = findCandidate(db, candidate_id);
      const { name, resume, ...profileUpdates } = updates;
      if (name !== undefined) assertNameFree(db, name, 'updates.name', candidate_id);
      const supplied = Object.fromEntries(
        Object.entries(profileUpdates).filter(([, value]) => value !== undefined),
      );
      const profile = { ...(JSON.parse(row.profile) as Profile), ...supplied };
      db.prepare(
        'UPDATE candidates SET name = ?, resume = ?, profile = ?, version = version + 1, updated_at = ? WHERE id = ?',
      ).run(name ?? row.name, resume ?? row.resume, JSON.stringify(profile), now(), candidate_id);
      return loadProfile(db, candidate_id);
    }),
});

const listCandidates = defineTool({
  name: 'list_candidates',
  description:
    'List all candidates (id and name only), most recently updated first. Call this at the start of a ' +
    'conversation to find the candidate_id.',
  schema: listCandidatesInput,
  handler: (db) => ({
    candidates: db
      .prepare(
        'SELECT id AS candidate_id, name, created_at, updated_at FROM candidates ORDER BY updated_at DESC, rowid DESC',
      )
      .all(),
  }),
});

export const candidateTools: Tool[] = [createCandidate, getCandidateProfile, updateCandidateProfile, listCandidates];
```

- [ ] **Step 6: Write `src/tools/index.ts`**

```ts
import type { Tool } from '../tool.js';
import { candidateTools } from './candidates.js';

export const tools: Tool[] = [...candidateTools];
```

- [ ] **Step 7: Run the tests and the typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: all tests in `db`, `envelope` and `candidates` PASS, typecheck prints nothing.

- [ ] **Step 8: Commit**

```bash
git add src/schemas.ts src/tools/candidates.ts src/tools/index.ts tests/helpers.ts tests/candidates.test.ts
git commit -m "Add candidate tools"
```

---

### Task 4: Job tools

**Files:**
- Modify: `src/schemas.ts` (append), `src/tools/index.ts`
- Create: `src/tools/jobs.ts`
- Test: `tests/jobs.test.ts`

**Interfaces:**
- Consumes: `id`, `text`, `strings` from `src/schemas.ts`; `requireCandidate(db, candidateId)` from `src/tools/candidates.ts`; `Db`, `newId`, `now`, `tx`; `CoachError`; `defineTool`, `Tool`; test helpers `useDb`, `advance`, `ok`, `fail`.
- Produces, from `src/schemas.ts`: `createTargetJobInput`, `getTargetJobInput`, `listTargetJobsInput`.
- Produces, from `src/tools/jobs.ts`:
  - `loadJob(db: Db, jobId: string)` — returns `{ job_id, candidate_id, company, title, description, requirements, location, metadata, created_at }`, throws `JOB_NOT_FOUND` with field `job_id`
  - `jobTools: Tool[]`

- [ ] **Step 1: Write the failing test**

`tests/jobs.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { advance, fail, ok, useDb } from './helpers.js';

const getDb = useDb();

function candidate(name = 'Val'): string {
  return ok(getDb(), 'create_candidate', { name }).candidate_id;
}

describe('create_target_job', () => {
  it('creates a job with defaults for optional fields', () => {
    const candidateId = candidate();
    const job = ok(getDb(), 'create_target_job', {
      candidate_id: candidateId,
      company: 'Palantir',
      title: 'Software Engineer Intern',
      description: 'Build data platforms.',
    });
    expect(job).toEqual({
      job_id: expect.stringMatching(/^job_[0-9a-f]{16}$/),
      candidate_id: candidateId,
      company: 'Palantir',
      title: 'Software Engineer Intern',
      description: 'Build data platforms.',
      requirements: [],
      location: null,
      metadata: {},
      created_at: '2026-01-01T00:00:00.000Z',
    });
  });

  it('stores optional fields and returns them from get_target_job', () => {
    const job = ok(getDb(), 'create_target_job', {
      candidate_id: candidate(),
      company: 'Palantir',
      title: 'SWE Intern',
      description: 'Build data platforms.',
      location: 'Denver, CO',
      requirements: ['Java', 'distributed systems'],
      metadata: { source: 'careers page', rounds: 3 },
    });
    expect(job).toMatchObject({
      location: 'Denver, CO',
      requirements: ['Java', 'distributed systems'],
      metadata: { source: 'careers page', rounds: 3 },
    });
    expect(ok(getDb(), 'get_target_job', { job_id: job.job_id })).toEqual(job);
  });

  it.each([['company'], ['title'], ['description']])('requires %s', (field) => {
    const input: Record<string, unknown> = {
      candidate_id: candidate(),
      company: 'Palantir',
      title: 'SWE Intern',
      description: 'Build data platforms.',
    };
    delete input[field];
    expect(fail(getDb(), 'create_target_job', input)).toMatchObject({ code: 'INVALID_INPUT', field });
  });

  it('rejects a whitespace-only description', () => {
    expect(
      fail(getDb(), 'create_target_job', {
        candidate_id: candidate(),
        company: 'Palantir',
        title: 'SWE Intern',
        description: '   ',
      }),
    ).toMatchObject({ code: 'INVALID_INPUT', field: 'description' });
  });

  it('rejects requirements that are not an array', () => {
    expect(
      fail(getDb(), 'create_target_job', {
        candidate_id: candidate(),
        company: 'Palantir',
        title: 'SWE Intern',
        description: 'Build.',
        requirements: 'Java',
      }),
    ).toMatchObject({ code: 'INVALID_FIELD_TYPE', field: 'requirements' });
  });

  it('fails for an unknown candidate and stores nothing', () => {
    expect(
      fail(getDb(), 'create_target_job', {
        candidate_id: 'cand_missing',
        company: 'Palantir',
        title: 'SWE Intern',
        description: 'Build.',
      }),
    ).toMatchObject({ code: 'CANDIDATE_NOT_FOUND', field: 'candidate_id' });
    expect(getDb().prepare('SELECT count(*) AS n FROM jobs').get()).toEqual({ n: 0 });
  });
});

describe('get_target_job', () => {
  it('fails for an unknown job', () => {
    expect(fail(getDb(), 'get_target_job', { job_id: 'job_missing' })).toEqual({
      code: 'JOB_NOT_FOUND',
      message: "Job 'job_missing' does not exist.",
      field: 'job_id',
      retryable: false,
    });
  });
});

describe('list_target_jobs', () => {
  it('lists only that candidate\'s jobs as summaries, newest first', () => {
    const mine = candidate('Val');
    const theirs = candidate('Sam');
    const first = ok(getDb(), 'create_target_job', {
      candidate_id: mine,
      company: 'Acme',
      title: 'Backend',
      description: 'SECRET DESCRIPTION',
    });
    advance();
    const second = ok(getDb(), 'create_target_job', {
      candidate_id: mine,
      company: 'Palantir',
      title: 'SWE Intern',
      description: 'Build.',
      location: 'Denver, CO',
    });
    ok(getDb(), 'create_target_job', { candidate_id: theirs, company: 'Other', title: 'X', description: 'Y' });

    expect(ok(getDb(), 'list_target_jobs', { candidate_id: mine })).toEqual({
      jobs: [
        {
          job_id: second.job_id,
          company: 'Palantir',
          title: 'SWE Intern',
          location: 'Denver, CO',
          created_at: '2026-01-01T00:00:01.000Z',
        },
        {
          job_id: first.job_id,
          company: 'Acme',
          title: 'Backend',
          location: null,
          created_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
  });

  it('returns an empty list for a candidate with no jobs', () => {
    expect(ok(getDb(), 'list_target_jobs', { candidate_id: candidate() })).toEqual({ jobs: [] });
  });

  it('fails for an unknown candidate', () => {
    expect(fail(getDb(), 'list_target_jobs', { candidate_id: 'cand_missing' })).toMatchObject({
      code: 'CANDIDATE_NOT_FOUND',
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/jobs.test.ts`
Expected: FAIL with "No tool named 'create_target_job' is registered."

- [ ] **Step 3: Append the job schemas to `src/schemas.ts`**

```ts
export const createTargetJobInput = z.strictObject({
  candidate_id: id,
  company: text,
  title: text,
  description: text,
  location: text.optional(),
  requirements: strings.default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export const getTargetJobInput = z.strictObject({ job_id: id });

export const listTargetJobsInput = z.strictObject({ candidate_id: id });
```

- [ ] **Step 4: Write `src/tools/jobs.ts`**

```ts
import { type Db, newId, now, tx } from '../db.js';
import { CoachError } from '../errors.js';
import { createTargetJobInput, getTargetJobInput, listTargetJobsInput } from '../schemas.js';
import { type Tool, defineTool } from '../tool.js';
import { requireCandidate } from './candidates.js';

interface JobRow {
  id: string;
  candidate_id: string;
  company: string;
  title: string;
  description: string;
  location: string | null;
  requirements: string;
  metadata: string;
  created_at: string;
}

export function loadJob(db: Db, jobId: string) {
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as JobRow | undefined;
  if (!row) throw new CoachError('JOB_NOT_FOUND', `Job '${jobId}' does not exist.`, 'job_id');
  return {
    job_id: row.id,
    candidate_id: row.candidate_id,
    company: row.company,
    title: row.title,
    description: row.description,
    requirements: JSON.parse(row.requirements) as string[],
    location: row.location,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    created_at: row.created_at,
  };
}

const createTargetJob = defineTool({
  name: 'create_target_job',
  description:
    'Save a job the candidate is preparing for. company, title and description are required and must come ' +
    'from the user or a real posting; the server never fills in missing job information.',
  schema: createTargetJobInput,
  handler: (db, input) =>
    tx(db, () => {
      requireCandidate(db, input.candidate_id);
      const jobId = newId('job');
      db.prepare(
        'INSERT INTO jobs (id, candidate_id, company, title, description, location, requirements, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        jobId,
        input.candidate_id,
        input.company,
        input.title,
        input.description,
        input.location ?? null,
        JSON.stringify(input.requirements),
        JSON.stringify(input.metadata),
        now(),
      );
      return loadJob(db, jobId);
    }),
});

const getTargetJob = defineTool({
  name: 'get_target_job',
  description: 'Retrieve a target job: company, title, full description, requirements, location and metadata.',
  schema: getTargetJobInput,
  handler: (db, { job_id }) => loadJob(db, job_id),
});

const listTargetJobs = defineTool({
  name: 'list_target_jobs',
  description: "List a candidate's target jobs (id, company, title, location), newest first.",
  schema: listTargetJobsInput,
  handler: (db, { candidate_id }) => {
    requireCandidate(db, candidate_id);
    return {
      jobs: db
        .prepare(
          'SELECT id AS job_id, company, title, location, created_at FROM jobs WHERE candidate_id = ? ORDER BY created_at DESC, rowid DESC',
        )
        .all(candidate_id),
    };
  },
});

export const jobTools: Tool[] = [createTargetJob, getTargetJob, listTargetJobs];
```

- [ ] **Step 5: Register the tools**

Replace `src/tools/index.ts` with:

```ts
import type { Tool } from '../tool.js';
import { candidateTools } from './candidates.js';
import { jobTools } from './jobs.js';

export const tools: Tool[] = [...candidateTools, ...jobTools];
```

- [ ] **Step 6: Run the tests and the typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: all tests PASS, typecheck prints nothing.

- [ ] **Step 7: Commit**

```bash
git add src/schemas.ts src/tools/jobs.ts src/tools/index.ts tests/jobs.test.ts
git commit -m "Add target job tools"
```

---

### Task 5: Interview lifecycle and events

**Files:**
- Modify: `src/schemas.ts` (append), `src/tools/index.ts`
- Create: `src/tools/interviews.ts`
- Test: `tests/interviews.test.ts`

**Interfaces:**
- Consumes: `id`, `text`, `strings`, `score`, `INTERVIEW_TYPES`, `EVENT_TYPES`, `EVENT_MAX` from `src/schemas.ts`; `requireCandidate` from `src/tools/candidates.ts`; `Db`, `newId`, `now`, `tx`; `CoachError`; `defineTool`, `Tool`; test helpers.
- Produces, from `src/schemas.ts`: `createInterviewInput`, `recordInterviewEventInput`, `finishInterviewInput`, `listInterviewsInput`.
- Produces, from `src/tools/interviews.ts`:
  - `loadInterview(db: Db, interviewId: string)` — returns `{ interview_id, candidate_id, job_id, interview_type, status, started_at, finished_at, overall_score, final_evaluation }` where `final_evaluation` is `null` or `{ category_scores, strengths, weaknesses, recommendations }`; throws `INTERVIEW_NOT_FOUND` with field `interview_id`
  - `interviewTools: Tool[]` containing `create_interview`, `record_interview_event`, `finish_interview`, `list_interviews` (Task 7 adds `get_interview_context`)

`answer` is deliberately a plain `z.string()` with no trim: answers are evidence and are stored exactly as given.

- [ ] **Step 1: Write the failing test**

`tests/interviews.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { advance, fail, ok, useDb } from './helpers.js';

const getDb = useDb();

function seed(name = 'Val') {
  const candidateId: string = ok(getDb(), 'create_candidate', { name }).candidate_id;
  const jobId: string = ok(getDb(), 'create_target_job', {
    candidate_id: candidateId,
    company: 'Palantir',
    title: 'SWE Intern',
    description: 'Build data platforms.',
  }).job_id;
  return { candidateId, jobId };
}

function interview(candidateId: string, jobId: string, type = 'technical'): string {
  return ok(getDb(), 'create_interview', { candidate_id: candidateId, job_id: jobId, interview_type: type })
    .interview_id;
}

const evaluation = {
  overall_score: 7.6,
  category_scores: { algorithms: 7, systems: 8, communication: 6, debugging: 9 },
  strengths: ['Systems reasoning'],
  weaknesses: ['Graph algorithms'],
  recommendations: ['Practice graph traversal'],
};

function eventRows(interviewId: string) {
  return getDb()
    .prepare('SELECT id, type, data, created_at FROM interview_events WHERE interview_id = ? ORDER BY id')
    .all(interviewId) as Array<{ id: number; type: string; data: string; created_at: string }>;
}

describe('create_interview', () => {
  it('creates an active interview', () => {
    const { candidateId, jobId } = seed();
    expect(
      ok(getDb(), 'create_interview', { candidate_id: candidateId, job_id: jobId, interview_type: 'technical' }),
    ).toEqual({
      interview_id: expect.stringMatching(/^int_[0-9a-f]{16}$/),
      candidate_id: candidateId,
      job_id: jobId,
      interview_type: 'technical',
      status: 'active',
      started_at: '2026-01-01T00:00:00.000Z',
    });
  });

  it.each([['technical'], ['behavioral'], ['system_design']])('accepts interview type %s', (type) => {
    const { candidateId, jobId } = seed();
    expect(
      ok(getDb(), 'create_interview', { candidate_id: candidateId, job_id: jobId, interview_type: type })
        .interview_type,
    ).toBe(type);
  });

  it('rejects an unknown interview type', () => {
    const { candidateId, jobId } = seed();
    expect(
      fail(getDb(), 'create_interview', { candidate_id: candidateId, job_id: jobId, interview_type: 'vibes' }),
    ).toMatchObject({ code: 'INVALID_INTERVIEW_TYPE', field: 'interview_type' });
  });

  it('fails for an unknown candidate', () => {
    const { jobId } = seed();
    expect(
      fail(getDb(), 'create_interview', {
        candidate_id: 'cand_missing',
        job_id: jobId,
        interview_type: 'technical',
      }),
    ).toMatchObject({ code: 'CANDIDATE_NOT_FOUND', field: 'candidate_id' });
  });

  it('fails for an unknown job', () => {
    const { candidateId } = seed();
    expect(
      fail(getDb(), 'create_interview', {
        candidate_id: candidateId,
        job_id: 'job_missing',
        interview_type: 'technical',
      }),
    ).toMatchObject({ code: 'JOB_NOT_FOUND', field: 'job_id' });
  });

  it('reports another candidate\'s job exactly like a missing job', () => {
    const val = seed('Val');
    const sam = seed('Sam');
    const foreign = fail(getDb(), 'create_interview', {
      candidate_id: val.candidateId,
      job_id: sam.jobId,
      interview_type: 'technical',
    });
    const missing = fail(getDb(), 'create_interview', {
      candidate_id: val.candidateId,
      job_id: 'job_missing',
      interview_type: 'technical',
    });
    expect(foreign.code).toBe('JOB_NOT_FOUND');
    expect(foreign.message.replace(sam.jobId, 'X')).toBe(missing.message.replace('job_missing', 'X'));
    expect(getDb().prepare('SELECT count(*) AS n FROM interviews').get()).toEqual({ n: 0 });
  });
});

describe('record_interview_event', () => {
  it('appends one event and returns its id', () => {
    const { candidateId, jobId } = seed();
    const interviewId = interview(candidateId, jobId);
    const result = ok(getDb(), 'record_interview_event', {
      interview_id: interviewId,
      event: {
        type: 'question_answered',
        category: 'graphs',
        difficulty: 'medium',
        question: 'Find the shortest path.',
        answer: 'Use BFS.',
        hints_used: 1,
        metadata: { language: 'python' },
      },
    });
    expect(result).toEqual({
      event_id: 1,
      interview_id: interviewId,
      type: 'question_answered',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    const rows = eventRows(interviewId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe('question_answered');
    expect(JSON.parse(rows[0]?.data ?? '')).toEqual({
      category: 'graphs',
      difficulty: 'medium',
      question: 'Find the shortest path.',
      answer: 'Use BFS.',
      hints_used: 1,
      metadata: { language: 'python' },
    });
  });

  it('accepts an event with only a type, and keeps events in order', () => {
    const { candidateId, jobId } = seed();
    const interviewId = interview(candidateId, jobId);
    const first = ok(getDb(), 'record_interview_event', { interview_id: interviewId, event: { type: 'question_asked' } });
    const second = ok(getDb(), 'record_interview_event', { interview_id: interviewId, event: { type: 'hint_requested' } });
    expect(second.event_id).toBeGreaterThan(first.event_id);
    expect(eventRows(interviewId).map((r) => r.type)).toEqual(['question_asked', 'hint_requested']);
  });

  it('stores answer text exactly as given', () => {
    const { candidateId, jobId } = seed();
    const interviewId = interview(candidateId, jobId);
    const answer = '    def bfs(g):\n\t    return "ok"  # naïve — 日本語 🚀\n\n';
    ok(getDb(), 'record_interview_event', {
      interview_id: interviewId,
      event: { type: 'question_answered', answer },
    });
    expect(JSON.parse(eventRows(interviewId)[0]?.data ?? '').answer).toBe(answer);
  });

  it('rejects an unknown event type', () => {
    const { candidateId, jobId } = seed();
    expect(
      fail(getDb(), 'record_interview_event', {
        interview_id: interview(candidateId, jobId),
        event: { type: 'candidate_sneezed' },
      }),
    ).toMatchObject({ code: 'INVALID_EVENT_TYPE', field: 'event.type' });
  });

  it('rejects an event without a type', () => {
    const { candidateId, jobId } = seed();
    expect(
      fail(getDb(), 'record_interview_event', {
        interview_id: interview(candidateId, jobId),
        event: { question: 'Hi?' },
      }),
    ).toMatchObject({ code: 'INVALID_EVENT_TYPE', field: 'event.type' });
  });

  it('rejects fields that are not part of the event schema', () => {
    const { candidateId, jobId } = seed();
    const interviewId = interview(candidateId, jobId);
    expect(
      fail(getDb(), 'record_interview_event', {
        interview_id: interviewId,
        event: { type: 'evaluation', verdict: 'good' },
      }),
    ).toMatchObject({ code: 'INVALID_FIELD', field: 'event.verdict' });
    expect(eventRows(interviewId)).toEqual([]);
  });

  it.each([
    ['difficulty', 'brutal', 'INVALID_INPUT'],
    ['hints_used', -1, 'INVALID_INPUT'],
    ['hints_used', 1.5, 'INVALID_FIELD_TYPE'],
    ['hints_used', 'two', 'INVALID_FIELD_TYPE'],
    ['metadata', 'notes', 'INVALID_FIELD_TYPE'],
  ])('rejects event.%s = %j', (field, value, code) => {
    const { candidateId, jobId } = seed();
    expect(
      fail(getDb(), 'record_interview_event', {
        interview_id: interview(candidateId, jobId),
        event: { type: 'question_asked', [field]: value },
      }),
    ).toMatchObject({ code, field: `event.${field}` });
  });

  it('rejects an oversized event', () => {
    const { candidateId, jobId } = seed();
    expect(
      fail(getDb(), 'record_interview_event', {
        interview_id: interview(candidateId, jobId),
        event: { type: 'question_answered', answer: 'x'.repeat(50_001) },
      }),
    ).toMatchObject({ code: 'INVALID_INPUT', field: 'event' });
  });

  it('fails for an unknown interview', () => {
    expect(
      fail(getDb(), 'record_interview_event', { interview_id: 'int_missing', event: { type: 'question_asked' } }),
    ).toEqual({
      code: 'INTERVIEW_NOT_FOUND',
      message: "Interview 'int_missing' does not exist.",
      field: 'interview_id',
      retryable: false,
    });
  });

  it('fails once the interview is completed', () => {
    const { candidateId, jobId } = seed();
    const interviewId = interview(candidateId, jobId);
    ok(getDb(), 'finish_interview', { interview_id: interviewId, ...evaluation });
    expect(
      fail(getDb(), 'record_interview_event', { interview_id: interviewId, event: { type: 'question_asked' } }),
    ).toMatchObject({ code: 'INTERVIEW_NOT_ACTIVE', field: 'interview_id', retryable: false });
    expect(eventRows(interviewId)).toEqual([]);
  });
});

describe('finish_interview', () => {
  it('completes the interview and stores the evaluation', () => {
    const { candidateId, jobId } = seed();
    const interviewId = interview(candidateId, jobId);
    advance(60_000);
    expect(ok(getDb(), 'finish_interview', { interview_id: interviewId, ...evaluation })).toEqual({
      interview_id: interviewId,
      candidate_id: candidateId,
      job_id: jobId,
      interview_type: 'technical',
      status: 'completed',
      started_at: '2026-01-01T00:00:00.000Z',
      finished_at: '2026-01-01T00:01:00.000Z',
      overall_score: 7.6,
      final_evaluation: {
        category_scores: evaluation.category_scores,
        strengths: evaluation.strengths,
        weaknesses: evaluation.weaknesses,
        recommendations: evaluation.recommendations,
      },
    });
  });

  it('cannot be completed twice, and the first evaluation is kept', () => {
    const { candidateId, jobId } = seed();
    const interviewId = interview(candidateId, jobId);
    ok(getDb(), 'finish_interview', { interview_id: interviewId, ...evaluation });
    expect(
      fail(getDb(), 'finish_interview', { interview_id: interviewId, ...evaluation, overall_score: 1 }),
    ).toMatchObject({ code: 'INTERVIEW_ALREADY_COMPLETED', field: 'interview_id', retryable: false });
    expect(getDb().prepare('SELECT overall_score FROM interviews WHERE id = ?').get(interviewId)).toEqual({
      overall_score: 7.6,
    });
  });

  it.each([
    [{ overall_score: 10.5 }, 'INVALID_SCORE', 'overall_score'],
    [{ category_scores: { algorithms: -1 } }, 'INVALID_SCORE', 'category_scores.algorithms'],
    [{ strengths: 'many' }, 'INVALID_FIELD_TYPE', 'strengths'],
    [{ recommendations: undefined }, 'INVALID_INPUT', 'recommendations'],
  ])('rejects %j and leaves the interview active', (override, code, field) => {
    const { candidateId, jobId } = seed();
    const interviewId = interview(candidateId, jobId);
    expect(fail(getDb(), 'finish_interview', { interview_id: interviewId, ...evaluation, ...override })).toMatchObject(
      { code, field },
    );
    expect(getDb().prepare('SELECT status FROM interviews WHERE id = ?').get(interviewId)).toEqual({
      status: 'active',
    });
  });

  it('fails for an unknown interview', () => {
    expect(fail(getDb(), 'finish_interview', { interview_id: 'int_missing', ...evaluation })).toMatchObject({
      code: 'INTERVIEW_NOT_FOUND',
      field: 'interview_id',
    });
  });
});

describe('list_interviews', () => {
  it('lists a candidate\'s interviews newest first and filters by status', () => {
    const { candidateId, jobId } = seed('Val');
    const other = seed('Sam');
    const first = interview(candidateId, jobId, 'technical');
    advance();
    const second = interview(candidateId, jobId, 'behavioral');
    interview(other.candidateId, other.jobId);
    advance();
    ok(getDb(), 'finish_interview', { interview_id: first, ...evaluation });

    expect(ok(getDb(), 'list_interviews', { candidate_id: candidateId })).toEqual({
      interviews: [
        {
          interview_id: second,
          job_id: jobId,
          interview_type: 'behavioral',
          status: 'active',
          started_at: '2026-01-01T00:00:01.000Z',
          finished_at: null,
          overall_score: null,
        },
        {
          interview_id: first,
          job_id: jobId,
          interview_type: 'technical',
          status: 'completed',
          started_at: '2026-01-01T00:00:00.000Z',
          finished_at: '2026-01-01T00:00:02.000Z',
          overall_score: 7.6,
        },
      ],
    });
    const active = ok(getDb(), 'list_interviews', { candidate_id: candidateId, status: 'active' });
    expect(active.interviews.map((i: { interview_id: string }) => i.interview_id)).toEqual([second]);
    const completed = ok(getDb(), 'list_interviews', { candidate_id: candidateId, status: 'completed' });
    expect(completed.interviews.map((i: { interview_id: string }) => i.interview_id)).toEqual([first]);
  });

  it('rejects an unknown status', () => {
    const { candidateId } = seed();
    expect(fail(getDb(), 'list_interviews', { candidate_id: candidateId, status: 'created' })).toMatchObject({
      code: 'INVALID_INPUT',
      field: 'status',
    });
  });

  it('fails for an unknown candidate', () => {
    expect(fail(getDb(), 'list_interviews', { candidate_id: 'cand_missing' })).toMatchObject({
      code: 'CANDIDATE_NOT_FOUND',
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/interviews.test.ts`
Expected: FAIL with "No tool named 'create_interview' is registered."

- [ ] **Step 3: Append the interview schemas to `src/schemas.ts`**

```ts
export const createInterviewInput = z.strictObject({
  candidate_id: id,
  job_id: id,
  interview_type: z.enum(INTERVIEW_TYPES),
});

export const recordInterviewEventInput = z.strictObject({
  interview_id: id,
  event: z
    .strictObject({
      type: z.enum(EVENT_TYPES),
      category: text.optional(),
      difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
      question: text.optional(),
      answer: z.string().optional(),
      hints_used: z.number().int().min(0).optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    })
    .refine((event) => JSON.stringify(event).length <= EVENT_MAX, {
      message: `event must serialize to at most ${EVENT_MAX} characters`,
    }),
});

export const finishInterviewInput = z.strictObject({
  interview_id: id,
  overall_score: score,
  category_scores: z.record(z.string(), score),
  strengths: strings,
  weaknesses: strings,
  recommendations: strings,
});

export const listInterviewsInput = z.strictObject({
  candidate_id: id,
  status: z.enum(['active', 'completed']).optional(),
});
```

- [ ] **Step 4: Write `src/tools/interviews.ts`**

```ts
import { type Db, newId, now, tx } from '../db.js';
import { CoachError } from '../errors.js';
import {
  createInterviewInput,
  finishInterviewInput,
  listInterviewsInput,
  recordInterviewEventInput,
} from '../schemas.js';
import { type Tool, defineTool } from '../tool.js';
import { requireCandidate } from './candidates.js';

interface InterviewRow {
  id: string;
  candidate_id: string;
  job_id: string;
  type: string;
  status: 'active' | 'completed';
  started_at: string;
  finished_at: string | null;
  overall_score: number | null;
  final_evaluation: string | null;
}

function findInterview(db: Db, interviewId: string): InterviewRow {
  const row = db.prepare('SELECT * FROM interviews WHERE id = ?').get(interviewId) as InterviewRow | undefined;
  if (!row) {
    throw new CoachError('INTERVIEW_NOT_FOUND', `Interview '${interviewId}' does not exist.`, 'interview_id');
  }
  return row;
}

export function loadInterview(db: Db, interviewId: string) {
  const row = findInterview(db, interviewId);
  return {
    interview_id: row.id,
    candidate_id: row.candidate_id,
    job_id: row.job_id,
    interview_type: row.type,
    status: row.status,
    started_at: row.started_at,
    finished_at: row.finished_at,
    overall_score: row.overall_score,
    final_evaluation: row.final_evaluation === null ? null : (JSON.parse(row.final_evaluation) as unknown),
  };
}

const createInterview = defineTool({
  name: 'create_interview',
  description:
    'Start a persistent interview session for a candidate and one of their target jobs. The interview is ' +
    'active immediately. The server creates no plan and no questions; you decide what the interview contains.',
  schema: createInterviewInput,
  handler: (db, { candidate_id, job_id, interview_type }) =>
    tx(db, () => {
      requireCandidate(db, candidate_id);
      const job = db.prepare('SELECT candidate_id FROM jobs WHERE id = ?').get(job_id) as
        | { candidate_id: string }
        | undefined;
      // A job owned by someone else is reported exactly like a missing one.
      if (!job || job.candidate_id !== candidate_id) {
        throw new CoachError('JOB_NOT_FOUND', `Job '${job_id}' does not exist for this candidate.`, 'job_id');
      }
      const interviewId = newId('int');
      const startedAt = now();
      db.prepare(
        "INSERT INTO interviews (id, candidate_id, job_id, type, status, started_at) VALUES (?, ?, ?, ?, 'active', ?)",
      ).run(interviewId, candidate_id, job_id, interview_type, startedAt);
      return {
        interview_id: interviewId,
        candidate_id,
        job_id,
        interview_type,
        status: 'active',
        started_at: startedAt,
      };
    }),
});

const recordInterviewEvent = defineTool({
  name: 'record_interview_event',
  description:
    'Append one event to the immutable record of an active interview: a question asked or answered, a hint, ' +
    'a follow-up, an evaluation note, or a completed topic. Put anything without a dedicated field in ' +
    'metadata. This only records what happened; it never changes skill scores.',
  schema: recordInterviewEventInput,
  handler: (db, { interview_id, event }) =>
    tx(db, () => {
      const interview = findInterview(db, interview_id);
      if (interview.status !== 'active') {
        throw new CoachError(
          'INTERVIEW_NOT_ACTIVE',
          `Interview '${interview_id}' is ${interview.status}; events can only be recorded on an active interview.`,
          'interview_id',
        );
      }
      const { type, ...data } = event;
      const createdAt = now();
      const info = db
        .prepare('INSERT INTO interview_events (interview_id, type, data, created_at) VALUES (?, ?, ?, ?)')
        .run(interview_id, type, JSON.stringify(data), createdAt);
      return { event_id: Number(info.lastInsertRowid), interview_id, type, created_at: createdAt };
    }),
});

const finishInterview = defineTool({
  name: 'finish_interview',
  description:
    'Close an active interview and store its final evaluation. This covers this one interview only and ' +
    "never changes the candidate's long-term skill scores; call update_skill_assessment first for those. " +
    'An interview can be finished only once.',
  schema: finishInterviewInput,
  handler: (db, { interview_id, overall_score, ...evaluation }) =>
    tx(db, () => {
      const interview = findInterview(db, interview_id);
      if (interview.status === 'completed') {
        throw new CoachError(
          'INTERVIEW_ALREADY_COMPLETED',
          `Interview '${interview_id}' is already completed.`,
          'interview_id',
        );
      }
      db.prepare(
        "UPDATE interviews SET status = 'completed', finished_at = ?, overall_score = ?, final_evaluation = ? WHERE id = ?",
      ).run(now(), overall_score, JSON.stringify(evaluation), interview_id);
      return loadInterview(db, interview_id);
    }),
});

const listInterviews = defineTool({
  name: 'list_interviews',
  description:
    "List a candidate's interviews, newest first, optionally only active or only completed ones. Use " +
    "status 'active' to find an unfinished interview to resume.",
  schema: listInterviewsInput,
  handler: (db, { candidate_id, status }) => {
    requireCandidate(db, candidate_id);
    const filter = status ?? null;
    return {
      interviews: db
        .prepare(
          `SELECT id AS interview_id, job_id, type AS interview_type, status, started_at, finished_at, overall_score
           FROM interviews
           WHERE candidate_id = ? AND (? IS NULL OR status = ?)
           ORDER BY started_at DESC, rowid DESC`,
        )
        .all(candidate_id, filter, filter),
    };
  },
});

export const interviewTools: Tool[] = [createInterview, recordInterviewEvent, finishInterview, listInterviews];
```

- [ ] **Step 5: Register the tools**

Replace `src/tools/index.ts` with:

```ts
import type { Tool } from '../tool.js';
import { candidateTools } from './candidates.js';
import { interviewTools } from './interviews.js';
import { jobTools } from './jobs.js';

export const tools: Tool[] = [...candidateTools, ...jobTools, ...interviewTools];
```

- [ ] **Step 6: Run the tests and the typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: all tests PASS, typecheck prints nothing.

- [ ] **Step 7: Commit**

```bash
git add src/schemas.ts src/tools/interviews.ts src/tools/index.ts tests/interviews.test.ts
git commit -m "Add interview lifecycle and event recording tools"
```

---

### Task 6: Skill assessment tool

**Files:**
- Modify: `src/schemas.ts` (append), `src/tools/index.ts`
- Create: `src/tools/skills.ts`
- Test: `tests/skills.test.ts`

**Interfaces:**
- Consumes: `id`, `text`, `score`, `confidence` from `src/schemas.ts`; `requireCandidate` from `src/tools/candidates.ts`; `Db`, `now`, `tx`; `CoachError`; `defineTool`, `Tool`; test helpers; the tools from Tasks 3–5 (used by tests to seed data).
- Produces, from `src/schemas.ts`: `updateSkillAssessmentInput`.
- Produces, from `src/tools/skills.ts`: `skillTools: Tool[]` containing `update_skill_assessment`.

- [ ] **Step 1: Write the failing test**

`tests/skills.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { advance, fail, ok, useDb } from './helpers.js';

const getDb = useDb();

function seed(name = 'Val') {
  const candidateId: string = ok(getDb(), 'create_candidate', { name }).candidate_id;
  const jobId: string = ok(getDb(), 'create_target_job', {
    candidate_id: candidateId,
    company: 'Palantir',
    title: 'SWE Intern',
    description: 'Build data platforms.',
  }).job_id;
  const interviewId: string = ok(getDb(), 'create_interview', {
    candidate_id: candidateId,
    job_id: jobId,
    interview_type: 'technical',
  }).interview_id;
  return { candidateId, jobId, interviewId };
}

function current(candidateId: string) {
  return getDb()
    .prepare(
      'SELECT skill, score, confidence, evidence, updated_at FROM skill_assessments WHERE candidate_id = ? ORDER BY skill',
    )
    .all(candidateId);
}

function history(candidateId: string) {
  return getDb()
    .prepare(
      'SELECT skill, score, confidence, evidence, interview_id, created_at FROM skill_assessment_history WHERE candidate_id = ? ORDER BY id',
    )
    .all(candidateId);
}

const graphs = { skill: 'graphs', score: 5, confidence: 0.8, evidence: 'Needed one hint on BFS.' };

describe('update_skill_assessment', () => {
  it('stores the current assessment and a history row', () => {
    const { candidateId, interviewId } = seed();
    const result = ok(getDb(), 'update_skill_assessment', {
      candidate_id: candidateId,
      interview_id: interviewId,
      skills: [graphs, { skill: 'systems', score: 8, confidence: 0.6, evidence: 'Clear design reasoning.' }],
    });
    expect(result).toEqual({
      candidate_id: candidateId,
      updated: [
        { ...graphs, updated_at: '2026-01-01T00:00:00.000Z' },
        {
          skill: 'systems',
          score: 8,
          confidence: 0.6,
          evidence: 'Clear design reasoning.',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    expect(current(candidateId)).toHaveLength(2);
    expect(history(candidateId)).toEqual([
      { ...graphs, interview_id: interviewId, created_at: '2026-01-01T00:00:00.000Z' },
      {
        skill: 'systems',
        score: 8,
        confidence: 0.6,
        evidence: 'Clear design reasoning.',
        interview_id: interviewId,
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ]);
  });

  it('overwrites the current row and appends to history on a later update', () => {
    const { candidateId, interviewId } = seed();
    ok(getDb(), 'update_skill_assessment', { candidate_id: candidateId, skills: [graphs] });
    advance();
    ok(getDb(), 'update_skill_assessment', {
      candidate_id: candidateId,
      interview_id: interviewId,
      skills: [{ skill: 'graphs', score: 6, confidence: 0.9, evidence: 'Solved Dijkstra unaided.' }],
    });
    expect(current(candidateId)).toEqual([
      {
        skill: 'graphs',
        score: 6,
        confidence: 0.9,
        evidence: 'Solved Dijkstra unaided.',
        updated_at: '2026-01-01T00:00:01.000Z',
      },
    ]);
    expect(history(candidateId)).toEqual([
      { ...graphs, interview_id: null, created_at: '2026-01-01T00:00:00.000Z' },
      {
        skill: 'graphs',
        score: 6,
        confidence: 0.9,
        evidence: 'Solved Dijkstra unaided.',
        interview_id: interviewId,
        created_at: '2026-01-01T00:00:01.000Z',
      },
    ]);
  });

  it('shows the current assessment in the candidate profile', () => {
    const { candidateId } = seed();
    ok(getDb(), 'update_skill_assessment', { candidate_id: candidateId, skills: [graphs] });
    expect(ok(getDb(), 'get_candidate_profile', { candidate_id: candidateId }).skill_assessment).toEqual({
      graphs: {
        score: 5,
        confidence: 0.8,
        evidence: 'Needed one hint on BFS.',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
    });
  });

  it('treats skill names as case- and whitespace-insensitive', () => {
    const { candidateId } = seed();
    ok(getDb(), 'update_skill_assessment', {
      candidate_id: candidateId,
      skills: [{ ...graphs, skill: '  Graphs ' }],
    });
    ok(getDb(), 'update_skill_assessment', {
      candidate_id: candidateId,
      skills: [{ ...graphs, skill: 'GRAPHS', score: 7 }],
    });
    expect(current(candidateId)).toMatchObject([{ skill: 'graphs', score: 7 }]);
  });

  it('rejects the same skill twice in one call', () => {
    const { candidateId } = seed();
    expect(
      fail(getDb(), 'update_skill_assessment', {
        candidate_id: candidateId,
        skills: [graphs, { ...graphs, skill: 'Graphs ', score: 9 }],
      }),
    ).toMatchObject({ code: 'INVALID_INPUT', field: 'skills' });
    expect(current(candidateId)).toEqual([]);
  });

  it('accepts the boundary values 0, 10, 0 and 1', () => {
    const { candidateId } = seed();
    ok(getDb(), 'update_skill_assessment', {
      candidate_id: candidateId,
      skills: [
        { skill: 'low', score: 0, confidence: 0, evidence: 'e' },
        { skill: 'high', score: 10, confidence: 1, evidence: 'e' },
      ],
    });
    expect(current(candidateId)).toMatchObject([
      { skill: 'high', score: 10, confidence: 1 },
      { skill: 'low', score: 0, confidence: 0 },
    ]);
  });

  it.each([
    ['score', 10.01, 'INVALID_SCORE'],
    ['score', -0.01, 'INVALID_SCORE'],
    ['score', '7', 'INVALID_SCORE'],
    ['score', Number.NaN, 'INVALID_SCORE'],
    ['score', Number.POSITIVE_INFINITY, 'INVALID_SCORE'],
    ['confidence', 1.01, 'INVALID_CONFIDENCE'],
    ['confidence', -0.1, 'INVALID_CONFIDENCE'],
    ['confidence', '0.8', 'INVALID_CONFIDENCE'],
    ['evidence', '   ', 'INVALID_INPUT'],
    ['skill', '', 'INVALID_INPUT'],
  ])('rejects %s = %j', (field, value, code) => {
    const { candidateId } = seed();
    expect(
      fail(getDb(), 'update_skill_assessment', {
        candidate_id: candidateId,
        skills: [{ ...graphs, [field]: value }],
      }),
    ).toMatchObject({ code, field: `skills.0.${field}` });
  });

  it('writes nothing when one entry in a batch is invalid', () => {
    const { candidateId } = seed();
    ok(getDb(), 'update_skill_assessment', { candidate_id: candidateId, skills: [graphs] });
    expect(
      fail(getDb(), 'update_skill_assessment', {
        candidate_id: candidateId,
        skills: [
          { skill: 'graphs', score: 9, confidence: 0.9, evidence: 'e' },
          { skill: 'systems', score: 42, confidence: 0.9, evidence: 'e' },
        ],
      }),
    ).toMatchObject({ code: 'INVALID_SCORE', field: 'skills.1.score' });
    expect(current(candidateId)).toMatchObject([{ skill: 'graphs', score: 5 }]);
    expect(history(candidateId)).toHaveLength(1);
  });

  it('rejects an empty skills list', () => {
    const { candidateId } = seed();
    expect(fail(getDb(), 'update_skill_assessment', { candidate_id: candidateId, skills: [] })).toMatchObject({
      code: 'INVALID_INPUT',
      field: 'skills',
    });
  });

  it('fails for an unknown candidate', () => {
    expect(
      fail(getDb(), 'update_skill_assessment', { candidate_id: 'cand_missing', skills: [graphs] }),
    ).toMatchObject({ code: 'CANDIDATE_NOT_FOUND', field: 'candidate_id' });
  });

  it('fails for an unknown interview and writes nothing', () => {
    const { candidateId } = seed();
    expect(
      fail(getDb(), 'update_skill_assessment', {
        candidate_id: candidateId,
        interview_id: 'int_missing',
        skills: [graphs],
      }),
    ).toMatchObject({ code: 'INTERVIEW_NOT_FOUND', field: 'interview_id' });
    expect(current(candidateId)).toEqual([]);
  });

  it('reports another candidate\'s interview as not found', () => {
    const val = seed('Val');
    const sam = seed('Sam');
    expect(
      fail(getDb(), 'update_skill_assessment', {
        candidate_id: val.candidateId,
        interview_id: sam.interviewId,
        skills: [graphs],
      }),
    ).toMatchObject({ code: 'INTERVIEW_NOT_FOUND', field: 'interview_id' });
    expect(history(val.candidateId)).toEqual([]);
  });

  it('accepts a completed interview as the source', () => {
    const { candidateId, interviewId } = seed();
    ok(getDb(), 'finish_interview', {
      interview_id: interviewId,
      overall_score: 7,
      category_scores: {},
      strengths: [],
      weaknesses: [],
      recommendations: [],
    });
    ok(getDb(), 'update_skill_assessment', {
      candidate_id: candidateId,
      interview_id: interviewId,
      skills: [graphs],
    });
    expect(history(candidateId)).toMatchObject([{ interview_id: interviewId }]);
  });
});

describe('no hidden mutations', () => {
  it('recording events and finishing an interview leave skill data untouched', () => {
    const { candidateId, interviewId } = seed();
    ok(getDb(), 'update_skill_assessment', { candidate_id: candidateId, skills: [graphs] });
    const currentBefore = current(candidateId);
    const historyBefore = history(candidateId);
    advance();

    ok(getDb(), 'record_interview_event', {
      interview_id: interviewId,
      event: { type: 'question_answered', category: 'graphs', difficulty: 'hard', answer: 'Wrong.', hints_used: 3 },
    });
    ok(getDb(), 'record_interview_event', {
      interview_id: interviewId,
      event: { type: 'evaluation', category: 'graphs', metadata: { score: 1 } },
    });
    ok(getDb(), 'finish_interview', {
      interview_id: interviewId,
      overall_score: 2,
      category_scores: { graphs: 1 },
      strengths: [],
      weaknesses: ['graphs'],
      recommendations: [],
    });

    expect(current(candidateId)).toEqual(currentBefore);
    expect(history(candidateId)).toEqual(historyBefore);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/skills.test.ts`
Expected: FAIL with "No tool named 'update_skill_assessment' is registered."

- [ ] **Step 3: Append the skill schema to `src/schemas.ts`**

```ts
export const updateSkillAssessmentInput = z.strictObject({
  candidate_id: id,
  interview_id: id.optional(),
  skills: z
    .array(
      z.strictObject({
        skill: z.string().trim().toLowerCase().min(1),
        score,
        confidence,
        evidence: text,
      }),
    )
    .min(1)
    .refine((skills) => new Set(skills.map((entry) => entry.skill)).size === skills.length, {
      message: 'each skill may appear only once per call',
    }),
});
```

- [ ] **Step 4: Write `src/tools/skills.ts`**

```ts
import { now, tx } from '../db.js';
import { CoachError } from '../errors.js';
import { updateSkillAssessmentInput } from '../schemas.js';
import { type Tool, defineTool } from '../tool.js';
import { requireCandidate } from './candidates.js';

const updateSkillAssessment = defineTool({
  name: 'update_skill_assessment',
  description:
    "Store your current assessment of one or more of the candidate's skills (score 0-10, confidence 0-1, " +
    'with the evidence behind it). Replaces the current value for each skill and appends to its history. ' +
    'Pass interview_id to link the change to the interview that produced it. The server stores the scores ' +
    'you give and never calculates its own. All skills are saved or none are.',
  schema: updateSkillAssessmentInput,
  handler: (db, { candidate_id, interview_id, skills }) =>
    tx(db, () => {
      requireCandidate(db, candidate_id);
      if (interview_id !== undefined) {
        const interview = db.prepare('SELECT candidate_id FROM interviews WHERE id = ?').get(interview_id) as
          | { candidate_id: string }
          | undefined;
        if (!interview || interview.candidate_id !== candidate_id) {
          throw new CoachError(
            'INTERVIEW_NOT_FOUND',
            `Interview '${interview_id}' does not exist for this candidate.`,
            'interview_id',
          );
        }
      }
      const timestamp = now();
      const upsert = db.prepare(
        `INSERT INTO skill_assessments (candidate_id, skill, score, confidence, evidence, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (candidate_id, skill) DO UPDATE SET
           score = excluded.score,
           confidence = excluded.confidence,
           evidence = excluded.evidence,
           updated_at = excluded.updated_at`,
      );
      const append = db.prepare(
        `INSERT INTO skill_assessment_history (candidate_id, skill, score, confidence, evidence, interview_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const entry of skills) {
        upsert.run(candidate_id, entry.skill, entry.score, entry.confidence, entry.evidence, timestamp);
        append.run(
          candidate_id,
          entry.skill,
          entry.score,
          entry.confidence,
          entry.evidence,
          interview_id ?? null,
          timestamp,
        );
      }
      return { candidate_id, updated: skills.map((entry) => ({ ...entry, updated_at: timestamp })) };
    }),
});

export const skillTools: Tool[] = [updateSkillAssessment];
```

- [ ] **Step 5: Register the tool**

Replace `src/tools/index.ts` with:

```ts
import type { Tool } from '../tool.js';
import { candidateTools } from './candidates.js';
import { interviewTools } from './interviews.js';
import { jobTools } from './jobs.js';
import { skillTools } from './skills.js';

export const tools: Tool[] = [...candidateTools, ...jobTools, ...interviewTools, ...skillTools];
```

- [ ] **Step 6: Run the tests and the typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: all tests PASS, typecheck prints nothing.

- [ ] **Step 7: Commit**

```bash
git add src/schemas.ts src/tools/skills.ts src/tools/index.ts tests/skills.test.ts
git commit -m "Add skill assessment tool"
```

---

### Task 7: Interview context

**Files:**
- Modify: `src/schemas.ts` (append), `src/tools/interviews.ts`
- Test: `tests/context.test.ts`

**Interfaces:**
- Consumes: `loadProfile(db, candidateId)` from `src/tools/candidates.ts`; `loadJob(db, jobId)` from `src/tools/jobs.ts`; `loadInterview(db, interviewId)` already in `src/tools/interviews.ts`; `id` from `src/schemas.ts`; all 12 tools from Tasks 3–6 (used by tests).
- Produces: `getInterviewContextInput` in `src/schemas.ts`; the `get_interview_context` tool, added to `interviewTools`. After this task `tools` has 13 entries.

- [ ] **Step 1: Write the failing test**

`tests/context.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { tools } from '../src/tools/index.js';
import { advance, fail, ok, useDb } from './helpers.js';

const getDb = useDb();

function seed() {
  const candidateId: string = ok(getDb(), 'create_candidate', { name: 'Val', resume: 'Resume', skills: ['Go'] })
    .candidate_id;
  const jobId: string = ok(getDb(), 'create_target_job', {
    candidate_id: candidateId,
    company: 'Palantir',
    title: 'SWE Intern',
    description: 'Build data platforms.',
  }).job_id;
  return { candidateId, jobId };
}

function interview(candidateId: string, jobId: string): string {
  return ok(getDb(), 'create_interview', { candidate_id: candidateId, job_id: jobId, interview_type: 'technical' })
    .interview_id;
}

function finish(interviewId: string, overall: number): void {
  ok(getDb(), 'finish_interview', {
    interview_id: interviewId,
    overall_score: overall,
    category_scores: { algorithms: overall },
    strengths: ['s'],
    weaknesses: ['w'],
    recommendations: ['r'],
  });
}

describe('tool registry', () => {
  it('exposes exactly the 13 tools of the spec', () => {
    expect(tools.map((t) => t.name).sort()).toEqual([
      'create_candidate',
      'create_interview',
      'create_target_job',
      'finish_interview',
      'get_candidate_profile',
      'get_interview_context',
      'get_target_job',
      'list_candidates',
      'list_interviews',
      'list_target_jobs',
      'record_interview_event',
      'update_candidate_profile',
      'update_skill_assessment',
    ]);
  });
});

describe('get_interview_context', () => {
  it('returns candidate, job, interview, events and skill history for an active interview', () => {
    const { candidateId, jobId } = seed();
    const interviewId = interview(candidateId, jobId);
    const answer = '    def bfs(g):\n\t    return "ok"  # naïve — 日本語 🚀\n\n';
    ok(getDb(), 'record_interview_event', {
      interview_id: interviewId,
      event: { type: 'question_asked', category: 'graphs', difficulty: 'medium', question: 'Shortest path?' },
    });
    advance();
    ok(getDb(), 'record_interview_event', {
      interview_id: interviewId,
      event: { type: 'question_answered', category: 'graphs', answer, hints_used: 1 },
    });
    ok(getDb(), 'update_skill_assessment', {
      candidate_id: candidateId,
      interview_id: interviewId,
      skills: [{ skill: 'graphs', score: 5, confidence: 0.8, evidence: 'One hint.' }],
    });

    const context = ok(getDb(), 'get_interview_context', { interview_id: interviewId });

    expect(Object.keys(context).sort()).toEqual([
      'candidate',
      'interview',
      'job',
      'previous_events',
      'recent_performance',
      'skill_history',
    ]);
    expect(context.candidate).toEqual(ok(getDb(), 'get_candidate_profile', { candidate_id: candidateId }));
    expect(context.job).toEqual(ok(getDb(), 'get_target_job', { job_id: jobId }));
    expect(context.interview).toEqual({
      interview_id: interviewId,
      candidate_id: candidateId,
      job_id: jobId,
      interview_type: 'technical',
      status: 'active',
      started_at: '2026-01-01T00:00:00.000Z',
      finished_at: null,
      overall_score: null,
      final_evaluation: null,
    });
    expect(context.previous_events).toEqual([
      {
        event_id: 1,
        type: 'question_asked',
        category: 'graphs',
        difficulty: 'medium',
        question: 'Shortest path?',
        created_at: '2026-01-01T00:00:00.000Z',
      },
      {
        event_id: 2,
        type: 'question_answered',
        category: 'graphs',
        answer,
        hints_used: 1,
        created_at: '2026-01-01T00:00:01.000Z',
      },
    ]);
    expect(context.skill_history).toEqual({
      current: [
        {
          skill: 'graphs',
          score: 5,
          confidence: 0.8,
          evidence: 'One hint.',
          updated_at: '2026-01-01T00:00:01.000Z',
        },
      ],
      history: [
        {
          skill: 'graphs',
          score: 5,
          confidence: 0.8,
          evidence: 'One hint.',
          interview_id: interviewId,
          created_at: '2026-01-01T00:00:01.000Z',
        },
      ],
    });
    expect(context.recent_performance).toEqual([]);
  });

  it('only includes events from this interview', () => {
    const { candidateId, jobId } = seed();
    const mine = interview(candidateId, jobId);
    const other = interview(candidateId, jobId);
    ok(getDb(), 'record_interview_event', { interview_id: other, event: { type: 'hint_given' } });
    ok(getDb(), 'record_interview_event', { interview_id: mine, event: { type: 'question_asked' } });
    const context = ok(getDb(), 'get_interview_context', { interview_id: mine });
    expect(context.previous_events.map((e: { type: string }) => e.type)).toEqual(['question_asked']);
  });

  it('returns the five most recently finished other interviews, newest first', () => {
    const { candidateId, jobId } = seed();
    const finished: string[] = [];
    for (let i = 1; i <= 6; i++) {
      const interviewId = interview(candidateId, jobId);
      advance();
      finish(interviewId, i);
      finished.push(interviewId);
    }
    const stillActive = interview(candidateId, jobId);
    const current = interview(candidateId, jobId);

    const context = ok(getDb(), 'get_interview_context', { interview_id: current });
    const ids = context.recent_performance.map((p: { interview_id: string }) => p.interview_id);
    expect(ids).toEqual([finished[5], finished[4], finished[3], finished[2], finished[1]]);
    expect(ids).not.toContain(stillActive);
    expect(context.recent_performance[0]).toEqual({
      interview_id: finished[5],
      job_id: jobId,
      interview_type: 'technical',
      finished_at: '2026-01-01T00:00:06.000Z',
      overall_score: 6,
      final_evaluation: {
        category_scores: { algorithms: 6 },
        strengths: ['s'],
        weaknesses: ['w'],
        recommendations: ['r'],
      },
    });
  });

  it('works for a completed interview and excludes it from recent_performance', () => {
    const { candidateId, jobId } = seed();
    const interviewId = interview(candidateId, jobId);
    finish(interviewId, 8);
    const context = ok(getDb(), 'get_interview_context', { interview_id: interviewId });
    expect(context.interview).toMatchObject({ status: 'completed', overall_score: 8 });
    expect(context.interview.final_evaluation).toMatchObject({ strengths: ['s'] });
    expect(context.recent_performance).toEqual([]);
  });

  it('does not include another candidate\'s interviews or skills', () => {
    const val = seed();
    const samId: string = ok(getDb(), 'create_candidate', { name: 'Sam' }).candidate_id;
    const samJob: string = ok(getDb(), 'create_target_job', {
      candidate_id: samId,
      company: 'Other',
      title: 'X',
      description: 'Y',
    }).job_id;
    finish(interview(samId, samJob), 3);
    ok(getDb(), 'update_skill_assessment', {
      candidate_id: samId,
      skills: [{ skill: 'trees', score: 2, confidence: 0.5, evidence: 'e' }],
    });

    const context = ok(getDb(), 'get_interview_context', {
      interview_id: interview(val.candidateId, val.jobId),
    });
    expect(context.recent_performance).toEqual([]);
    expect(context.skill_history).toEqual({ current: [], history: [] });
  });

  it('writes nothing', () => {
    const { candidateId, jobId } = seed();
    const interviewId = interview(candidateId, jobId);
    const before = getDb().prepare('SELECT total_changes() AS n').get();
    ok(getDb(), 'get_interview_context', { interview_id: interviewId });
    expect(getDb().prepare('SELECT total_changes() AS n').get()).toEqual(before);
  });

  it('fails for an unknown interview', () => {
    expect(fail(getDb(), 'get_interview_context', { interview_id: 'int_missing' })).toMatchObject({
      code: 'INTERVIEW_NOT_FOUND',
      field: 'interview_id',
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/context.test.ts`
Expected: FAIL; the registry test lists 12 tools, the others report "No tool named 'get_interview_context' is registered."

- [ ] **Step 3: Append the schema to `src/schemas.ts`**

```ts
export const getInterviewContextInput = z.strictObject({ interview_id: id });
```

- [ ] **Step 4: Add the tool to `src/tools/interviews.ts`**

Change the schema import and add two imports at the top of the file:

```ts
import {
  createInterviewInput,
  finishInterviewInput,
  getInterviewContextInput,
  listInterviewsInput,
  recordInterviewEventInput,
} from '../schemas.js';
import { type Tool, defineTool } from '../tool.js';
import { loadProfile, requireCandidate } from './candidates.js';
import { loadJob } from './jobs.js';
```

Add this tool definition above the `interviewTools` export:

```ts
interface EventRow {
  id: number;
  type: string;
  data: string;
  created_at: string;
}

interface PerformanceRow {
  interview_id: string;
  job_id: string;
  interview_type: string;
  finished_at: string;
  overall_score: number;
  final_evaluation: string;
}

const RECENT_INTERVIEWS = 5;

const getInterviewContext = defineTool({
  name: 'get_interview_context',
  description:
    'Retrieve everything needed to continue or review an interview in one call: the candidate profile, the ' +
    "target job, the interview, every event recorded so far (oldest first), the candidate's current and " +
    'historical skill assessments, and the final evaluations of their five most recently finished other ' +
    'interviews. This is the main read tool during an interview. It returns stored data only; it computes ' +
    'no summaries.',
  schema: getInterviewContextInput,
  handler: (db, { interview_id }) => {
    const interview = loadInterview(db, interview_id);
    const events = db
      .prepare('SELECT id, type, data, created_at FROM interview_events WHERE interview_id = ? ORDER BY id')
      .all(interview_id) as EventRow[];
    const recent = db
      .prepare(
        `SELECT id AS interview_id, job_id, type AS interview_type, finished_at, overall_score, final_evaluation
         FROM interviews
         WHERE candidate_id = ? AND status = 'completed' AND id <> ?
         ORDER BY finished_at DESC, rowid DESC
         LIMIT ?`,
      )
      .all(interview.candidate_id, interview_id, RECENT_INTERVIEWS) as PerformanceRow[];
    return {
      candidate: loadProfile(db, interview.candidate_id),
      job: loadJob(db, interview.job_id),
      interview,
      previous_events: events.map((row) => ({
        event_id: row.id,
        type: row.type,
        ...(JSON.parse(row.data) as Record<string, unknown>),
        created_at: row.created_at,
      })),
      skill_history: {
        current: db
          .prepare(
            'SELECT skill, score, confidence, evidence, updated_at FROM skill_assessments WHERE candidate_id = ? ORDER BY skill',
          )
          .all(interview.candidate_id),
        history: db
          .prepare(
            'SELECT skill, score, confidence, evidence, interview_id, created_at FROM skill_assessment_history WHERE candidate_id = ? ORDER BY id',
          )
          .all(interview.candidate_id),
      },
      recent_performance: recent.map((row) => ({
        ...row,
        final_evaluation: JSON.parse(row.final_evaluation) as unknown,
      })),
    };
  },
});
```

Replace the `interviewTools` export with:

```ts
export const interviewTools: Tool[] = [
  createInterview,
  recordInterviewEvent,
  getInterviewContext,
  finishInterview,
  listInterviews,
];
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: all tests PASS, typecheck prints nothing.

- [ ] **Step 6: Commit**

```bash
git add src/schemas.ts src/tools/interviews.ts tests/context.test.ts
git commit -m "Add get_interview_context"
```

---

### Task 8: MCP server, entry point and README

**Files:**
- Create: `src/server.ts`, `src/index.ts`, `README.md`
- Test: `tests/server.test.ts`

**Interfaces:**
- Consumes: `tools: Tool[]` from `src/tools/index.ts`; `callTool(db, tool, rawArgs): Envelope`, `Envelope` from `src/tool.ts`; `Db`, `openDb`, `defaultDbPath` from `src/db.ts`.
- Produces: `buildServer(db: Db): Server` from `src/server.ts` (the SDK's low-level `Server`, not yet connected to a transport); the executable `dist/index.js`.

SDK imports used, all from `@modelcontextprotocol/sdk` 1.x: `Server` from `/server/index.js`; `StdioServerTransport` from `/server/stdio.js`; `ListToolsRequestSchema`, `CallToolRequestSchema` from `/types.js`; for the test, `Client` from `/client/index.js` and `InMemoryTransport` from `/inMemory.js`. `z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' })` turns a strict zod object into a JSON Schema with `type: "object"` and `additionalProperties: false`; fields with defaults come out optional.

- [ ] **Step 1: Write the failing test**

`tests/server.test.ts`:

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Db, openDb } from '../src/db.js';
import { buildServer } from '../src/server.js';

let db: Db;
let client: Client;
let logged: string[];

beforeEach(async () => {
  logged = [];
  vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => {
    logged.push(parts.map(String).join(' '));
  });
  db = openDb(':memory:');
  const server = buildServer(db);
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
    expect(client.getServerVersion()).toMatchObject({ name: 'interview-coach', version: '0.1.0' });
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/server.test.ts`
Expected: FAIL, cannot resolve `../src/server.js`.

- [ ] **Step 3: Write `src/server.ts`**

```ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Db } from './db.js';
import { type Envelope, callTool } from './tool.js';
import { tools } from './tools/index.js';

const INSTRUCTIONS = `This server is the memory for a technical interview coach. You are the interviewer: you plan the interview, write the questions, give hints and evaluate answers. The server only stores and retrieves.

Workflow:
1. Start with list_candidates. If the person is not there, create_candidate. Then list_target_jobs or create_target_job.
2. To resume, list_interviews with status "active" and call get_interview_context. Otherwise create_interview.
3. During the interview, call record_interview_event for each question, answer, hint and evaluation as it happens.
4. At the end, call update_skill_assessment for any skill whose score you would now change, then finish_interview.

Every tool returns {"success": true, "data": ...} or {"success": false, "error": {code, message, field, retryable}}. Never tell the user something was saved unless the tool returned success: true. If retryable is false, fix the input or tell the user plainly what was not saved; do not repeat the same call. The user should not need to know these tools exist.`;

type ObjectSchema = { type: 'object'; [key: string]: unknown };

export function buildServer(db: Db): Server {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const server = new Server(
    { name: 'interview-coach', version: '0.1.0' },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

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
```

- [ ] **Step 4: Write `src/index.ts`**

```ts
#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { defaultDbPath, openDb } from './db.js';
import { buildServer } from './server.js';

const db = openDb(defaultDbPath());
const server = buildServer(db);
await server.connect(new StdioServerTransport());
console.error('interview-coach MCP server running on stdio');
```

- [ ] **Step 5: Run the full suite, the typecheck and the build**

Run: `npx vitest run && npm run typecheck && npm run build`
Expected: all tests PASS, typecheck prints nothing, and `dist/index.js` exists.

- [ ] **Step 6: Smoke-test the built server over stdio**

This uses a temporary database so the real one is not created.

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_candidates","arguments":{}}}' \
  | COACH_DB_PATH="$(mktemp -d)/coach.db" node dist/index.js
```

Expected on stdout: two JSON-RPC responses. The first has `"serverInfo":{"name":"interview-coach","version":"0.1.0"}`; the second contains the text `{\"success\":true,\"data\":{\"candidates\":[]}}`. Stderr shows the startup line and one log line for `list_candidates`.

- [ ] **Step 7: Write `README.md`**

````markdown
# Interview Coach MCP

A local MCP server that gives Claude a memory for running technical interviews.
Claude is the interviewer; this server stores candidates, target jobs,
interviews, the event log of each interview, and the candidate's skill
assessments in a SQLite file on your machine. It calls no external services.

Design documents: `0001_mcp_initial_design.md` and
`docs/superpowers/specs/2026-10-05-interview-coach-mcp-design.md`.

## Requirements

Node 24 or newer.

## Build

```bash
npm install
npm run build
```

## Register with Claude Code

```bash
claude mcp add interview-coach -- node /absolute/path/to/mohr-mcp/dist/index.js
```

Then start a conversation with something like "I'm preparing for a software
engineering internship interview at Palantir; here is my resume and the job
posting."

## Data

The database lives at `~/.interview-coach/coach.db`. Set `COACH_DB_PATH` to use
a different file:

```bash
claude mcp add interview-coach -e COACH_DB_PATH=/path/to/coach.db -- node /absolute/path/to/mohr-mcp/dist/index.js
```

Deleting the file deletes all stored data. The server logs one line per tool
call to stderr (tool name, outcome, duration) and never logs resume or answer
text.

## Tools

| Area | Tools |
|---|---|
| Candidate | `create_candidate`, `get_candidate_profile`, `update_candidate_profile`, `list_candidates` |
| Job | `create_target_job`, `get_target_job`, `list_target_jobs` |
| Interview | `create_interview`, `record_interview_event`, `get_interview_context`, `finish_interview`, `list_interviews` |
| Skills | `update_skill_assessment` |

Every tool returns `{"success": true, "data": ...}` or
`{"success": false, "error": {"code", "message", "field", "retryable"}}`.

## Development

```bash
npm test          # run the test suite
npm run typecheck # type-check src and tests
```
````

- [ ] **Step 8: Commit**

```bash
git add src/server.ts src/index.ts tests/server.test.ts README.md
git commit -m "Add MCP server wiring, stdio entry point and README"
```

---

## Spec Coverage

| Spec section | Task |
|---|---|
| 3. Departures (name, resume, state machine, job owner, `interview_id`, history, version, retryable) | 1 (schema), 3, 4, 5, 6, 2 |
| 4. Architecture, envelope, validation in the wrapper | 2, 8 |
| 4. Server instructions | 8 |
| 4. Storage path, pragmas | 1 |
| 5. Data model, append-only triggers | 1 |
| 6. Candidate tools | 3 |
| 6. Job tools | 4 |
| 6. Interview tools | 5, 7 |
| 6. Skills tool | 6 |
| 6. Write ownership | 6 ("no hidden mutations"), 7 ("writes nothing") |
| 7. Validation and error mapping | 2, and per-tool cases in 3–6 |
| 8. Privacy and logging | 2 (sanitized errors), 5 and 6 (cross-candidate checks), 8 (logging) |
| 9. Testing | every task; end-to-end in 8 |
| 10. Running it | 8 |
