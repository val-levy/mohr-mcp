# Interview Coach MCP — v1 Design Spec

Date: 2026-10-05
Source: `0001_mcp_initial_design.md` (the "initial design"). This spec turns it into
a buildable v1 and records every place it departs from that document.

## 1. Purpose

A local MCP server that is the memory and toolkit for Claude acting as a technical
interviewer. Claude does all reasoning (planning, questions, hints, evaluation,
skill assessment). The server only persists and retrieves state.

Boundary rule, unchanged from the initial design: if an operation requires
reasoning it belongs to Claude; if it requires persistent state or deterministic
data access it belongs to the server.

Success for v1: a user talks only to Claude, runs a job-tailored interview, and in
a later conversation Claude finds the same candidate, jobs, interview history and
skill model through the tools alone.

## 2. Scope

In scope:

- 13 tools (section 5) over a local SQLite database
- Strict input validation, structured `{success, data | error}` responses
- Transactional writes, append-only event log
- stdio transport, single machine, no external APIs, no authentication

Out of scope for v1: everything under "Future MCP Extensions" in the initial
design, HTTP transport, multi-user access control, pagination, idempotency keys,
down-migrations, and delete tools.

The schema lives in versioned SQL files under `db/migrations/` (`0001_initial_schema.sql`,
...), never inside TypeScript. On startup the migrator applies every file the database
has not seen, each in its own transaction, and records it with a checksum in
`schema_migrations`. It refuses to start if an applied file was edited or removed or a
new file is numbered out of order. A schema change is a new numbered file. Sample data
lives in `db/seeds/` and is loaded only by `npm run db:seed`, never on startup.

Code is organised by feature: `src/core/` (server, envelope, errors), `src/storage/`
(database, migrator, seeder) and one folder each for candidates, jobs, interviews and
skills holding that feature's `schemas.ts` and `tools.ts`. This supersedes the file
list below. Candidate names are unique ignoring case in any script, via a folded
`name_key` column.

## 3. Departures from the initial design

| # | Initial design | v1 | Reason |
|---|---|---|---|
| 1 | 8 tools | 13 tools: adds `create_candidate`, `create_target_job`, `list_candidates`, `list_target_jobs`, `list_interviews` | Nothing could create a candidate or job, and a new conversation could not discover IDs |
| 2 | Candidate has no name | `candidates.name`, required, unique ignoring case | `list_candidates` needs something to show; uniqueness stops the same person being created twice |
| 3 | `resume` not in `updates` | `resume` is writable on create and update | It was readable but could never be set |
| 4 | `CREATED → ACTIVE → COMPLETED` | `ACTIVE → COMPLETED` | No tool moved an interview out of `CREATED`; `create_interview` already returned `active` |
| 5 | `jobs` has no owner | `jobs.candidate_id`, required | A target job is a candidate's target; needed for `list_target_jobs` and to stop cross-candidate access |
| 6 | `update_skill_assessment` has no `interview_id` | Optional `interview_id` | `skill_assessment_history.interview_id` could not otherwise be filled |
| 7 | History table "optional" | Always written | Costs one insert and is what `get_interview_context` returns as skill history |
| 8 | "Versioning" of the profile unspecified | Integer `version`, incremented on every profile update | Minimal reading of the requirement; no stored past versions |
| 9 | Retryable codes named `DATABASE_UNAVAILABLE`, `TEMPORARY_STORAGE_ERROR`, `TIMEOUT` | Only `STORAGE_UNAVAILABLE` is retryable | The initial design's own code list does not contain those three names |

## 4. Architecture

Stack: TypeScript on Node 24, `@modelcontextprotocol/sdk`, `zod`, `better-sqlite3`,
`vitest`. Package name `interview-coach-mcp`, server name `interview-coach`.

```
src/
  index.ts        stdio entry point: open db, build server, connect transport
  server.ts       tool registry; wraps every handler in the envelope
  db.ts           open database, run migrations, transaction helper
  migrate.ts      applies pending migrations/*.sql, tracks them in schema_migrations
  errors.ts       error codes, CoachError, zod and SQLite error mapping
  schemas.ts      strict zod input schemas, one per tool
  tools/
    candidates.ts create_candidate, get_candidate_profile,
                  update_candidate_profile, list_candidates
    jobs.ts       create_target_job, get_target_job, list_target_jobs
    interviews.ts create_interview, record_interview_event,
                  get_interview_context, finish_interview, list_interviews
    skills.ts     update_skill_assessment
tests/            one file per tool group, plus envelope and db tests
```

Layering:

- A handler is a plain function `(db, input) => data`. It receives input already
  parsed by its zod schema, returns the `data` payload, and throws `CoachError`
  for every expected failure. Handlers know nothing about MCP.
- `server.ts` is the only place that touches the protocol. For each call it
  parses the raw arguments with the tool's schema, runs the handler, and converts
  the result or the thrown error into the envelope.
- Validation runs inside this wrapper, not in the SDK's own argument validation,
  so that a malformed call still comes back as an envelope with one of our error
  codes rather than a protocol-level error.

Response format: one text content block containing the JSON envelope. Failures
also set the MCP result's `isError` to true.

```json
{ "success": true, "data": {} }
```

```json
{
  "success": false,
  "error": {
    "code": "INTERVIEW_NOT_FOUND",
    "message": "Interview 'int_123' does not exist.",
    "field": "interview_id",
    "retryable": false
  }
}
```

`field` is present when the error is attributable to one input field (dotted
path, for example `skills.1.score`), otherwise omitted.

Server instructions (the MCP `instructions` string) tell Claude, in a few lines:
start by calling `list_candidates`; record events as the interview proceeds; at
the end call `update_skill_assessment` then `finish_interview`; and never tell
the user something was saved when a tool returned `success: false`.

Storage: `~/.interview-coach/coach.db`, directory created on first run, overridable
with the `COACH_DB_PATH` environment variable. Opened with `foreign_keys = ON`,
`journal_mode = WAL`, `busy_timeout = 5000`. Tests use `:memory:`.

## 5. Data model

All IDs are server-generated: prefix plus 16 random hex characters (`cand_`,
`job_`, `int_`). Timestamps are ISO 8601 UTC strings. JSON columns hold validated
JSON text.

```
candidates
    id            TEXT PRIMARY KEY
    name          TEXT NOT NULL, unique ignoring case
    resume        TEXT NOT NULL DEFAULT ''
    profile       TEXT NOT NULL  (JSON: experience, projects, skills,
                                  interests, preferences)
    version       INTEGER NOT NULL DEFAULT 1
    created_at, updated_at

jobs
    id            TEXT PRIMARY KEY
    candidate_id  TEXT NOT NULL REFERENCES candidates(id)
    company, title, description   TEXT NOT NULL
    location      TEXT
    requirements  TEXT NOT NULL  (JSON array of strings)
    metadata      TEXT NOT NULL  (JSON object)
    created_at

interviews
    id            TEXT PRIMARY KEY
    candidate_id  TEXT NOT NULL REFERENCES candidates(id)
    job_id        TEXT NOT NULL REFERENCES jobs(id)
    type          TEXT NOT NULL
    status        TEXT NOT NULL CHECK (status IN ('active','completed'))
    started_at    TEXT NOT NULL
    finished_at   TEXT
    overall_score REAL
    final_evaluation TEXT  (JSON; null until finished)

interview_events
    id            INTEGER PRIMARY KEY AUTOINCREMENT  (defines event order)
    interview_id  TEXT NOT NULL REFERENCES interviews(id)
    type          TEXT NOT NULL
    data          TEXT NOT NULL  (JSON: the event minus its type)
    created_at    TEXT NOT NULL

skill_assessments              (current state; one row per candidate and skill)
    candidate_id  TEXT NOT NULL REFERENCES candidates(id)
    skill         TEXT NOT NULL
    score         REAL NOT NULL
    confidence    REAL NOT NULL
    evidence      TEXT NOT NULL
    updated_at    TEXT NOT NULL
    PRIMARY KEY (candidate_id, skill)

skill_assessment_history       (append-only; one row per skill per update call)
    id            INTEGER PRIMARY KEY AUTOINCREMENT
    candidate_id, skill, score, confidence, evidence
    interview_id  TEXT REFERENCES interviews(id)   (nullable)
    created_at    TEXT NOT NULL
```

`interview_events` is made immutable in the database itself: `BEFORE UPDATE` and
`BEFORE DELETE` triggers raise an error. No tool updates or deletes events.

## 6. Tools

Every tool input is a strict object: unknown keys are rejected. "ID" means a
non-empty string. Unless stated otherwise, strings are trimmed and must be
non-empty.

### Candidate

Profile field shapes, used by create and update:

- `skills`, `interests`, `preferences`: arrays of strings
- `experience`: array of `{ title, organization, start?, end?, description? }`
- `projects`: array of `{ name, description, technologies?: string[], url? }`
- `resume`: string, at most 100,000 characters

**`create_candidate`** — input `{ name, resume?, experience?, projects?, skills?,
interests?, preferences? }`. Omitted arrays default to empty, `resume` to `''`.
Returns the full profile (same shape as `get_candidate_profile`). Fails with
`DUPLICATE_RESOURCE` if a candidate with that name already exists.

**`get_candidate_profile`** — input `{ candidate_id }`. Returns:

```json
{
  "candidate_id": "cand_…", "name": "…", "version": 3,
  "resume": "…", "experience": [], "projects": [], "skills": [],
  "interests": [], "preferences": [],
  "skill_assessment": {
    "graphs": { "score": 6, "confidence": 0.8, "evidence": "…", "updated_at": "…" }
  },
  "created_at": "…", "updated_at": "…"
}
```

`skill_assessment` is read from `skill_assessments`; this tool never writes it.

**`update_candidate_profile`** — input `{ candidate_id, updates }` where `updates`
may contain any of `name`, `resume`, `experience`, `projects`, `skills`,
`interests`, `preferences`, and must contain at least one. Each supplied field
replaces the stored value whole; arrays are not merged. Increments `version`,
sets `updated_at`. Returns the full updated profile. Renaming to a name already
in use fails with `DUPLICATE_RESOURCE`.

**`list_candidates`** — input `{}`. Returns
`{ candidates: [{ candidate_id, name, created_at, updated_at }] }`, newest
`updated_at` first. Never includes resume or profile content.

### Job

**`create_target_job`** — input `{ candidate_id, company, title, description,
location?, requirements?: string[], metadata?: object }`. `company`, `title` and
`description` are required and non-empty; the server never infers missing job
information. Returns the full job.

**`get_target_job`** — input `{ job_id }`. Returns `{ job_id, candidate_id,
company, title, description, requirements, location, metadata, created_at }`.

**`list_target_jobs`** — input `{ candidate_id }`. Returns
`{ jobs: [{ job_id, company, title, location, created_at }] }`, newest first.

### Interview

**`create_interview`** — input `{ candidate_id, job_id, interview_type }` with
`interview_type` one of `technical`, `behavioral`, `system_design`. The job must
belong to the candidate; if it does not, the error is `JOB_NOT_FOUND` so that one
candidate's ID cannot confirm another candidate's job exists. Returns
`{ interview_id, candidate_id, job_id, interview_type, status: "active",
started_at }`. The server creates no plan and no questions.

**`record_interview_event`** — input `{ interview_id, event }`:

```
event.type        required; one of question_asked, question_answered,
                  hint_requested, hint_given, follow_up, evaluation,
                  topic_completed
event.category    optional string
event.difficulty  optional; easy | medium | hard
event.question    optional string
event.answer      optional string
event.hints_used  optional integer >= 0
event.metadata    optional object, free-form
```

Anything not listed must go inside `metadata`. The serialized event may not
exceed 50,000 characters. The interview must be `active`. Appends exactly one row
to `interview_events` and writes nothing else. Returns `{ event_id, interview_id,
type, created_at }`.

**`get_interview_context`** — input `{ interview_id }`. Works for active and
completed interviews. Read-only. Returns:

```
candidate           full profile, as get_candidate_profile
job                 full job, as get_target_job
interview           the interview row, including final_evaluation if finished
previous_events     every event of this interview, oldest first
skill_history       { current: [...skill_assessments rows],
                      history: [...skill_assessment_history rows, oldest first] }
recent_performance  the candidate's 5 most recently finished other interviews:
                    [{ interview_id, job_id, interview_type, finished_at,
                       overall_score, final_evaluation }]
```

Everything here is stored data returned as stored. The server computes no
averages, trends or summaries.

**`finish_interview`** — input `{ interview_id, overall_score, category_scores,
strengths, weaknesses, recommendations }`. `overall_score` and every value in
`category_scores` (an object of name to number) are scores from 0 to 10; the three
lists are arrays of strings. In one transaction: check the interview is `active`,
then set `status = 'completed'`, `finished_at`, `overall_score`, and
`final_evaluation` (the category scores and three lists). Writes nothing to
`skill_assessments`. Returns the completed interview row.

**`list_interviews`** — input `{ candidate_id, status?: "active" | "completed" }`.
Returns `{ interviews: [{ interview_id, job_id, interview_type, status,
started_at, finished_at, overall_score }] }`, newest `started_at` first.

### Skills

**`update_skill_assessment`** — input `{ candidate_id, interview_id?, skills }`
where `skills` is a non-empty array of `{ skill, score, confidence, evidence }`.

- `skill` is trimmed and lower-cased before storage, so `Graphs` and `graphs` are
  one skill. The same skill twice in one call is `INVALID_INPUT`.
- `score` is a finite number from 0 to 10; `confidence` a finite number from 0
  to 1; `evidence` a non-empty string.
- `interview_id`, if given, must be an interview of this candidate (active or
  completed), otherwise `INTERVIEW_NOT_FOUND`.

In one transaction, for every skill: upsert the `skill_assessments` row and append
a `skill_assessment_history` row. If any entry is invalid nothing is written.
Returns `{ candidate_id, updated: [{ skill, score, confidence, evidence,
updated_at }] }`. The server stores the scores it is given and calculates none.

### Write ownership

| Data | Written only by |
|---|---|
| Candidate row | `create_candidate`, `update_candidate_profile` |
| Job row | `create_target_job` |
| Interview row | `create_interview`, `finish_interview` |
| Interview events | `record_interview_event` |
| Skill assessments and history | `update_skill_assessment` |

## 7. Validation and errors

Order of checks in every tool: parse input, then verify referenced entities
exist, then verify state, then write inside a transaction. A failure at any step
leaves the database unchanged.

Mapping from validation failures to codes:

| Failure | Code |
|---|---|
| Unknown key in any object | `INVALID_FIELD` |
| Wrong type for a known field | `INVALID_FIELD_TYPE` |
| An `*_id` field missing, empty, or not a string | `INVALID_ID` |
| Score not a finite number in 0–10 | `INVALID_SCORE` |
| Confidence not a finite number in 0–1 | `INVALID_CONFIDENCE` |
| Unknown `event.type` | `INVALID_EVENT_TYPE` |
| Unknown `interview_type` | `INVALID_INTERVIEW_TYPE` |
| Any other input problem (empty required string, size limit, empty `updates`, duplicate skill in batch) | `INVALID_INPUT` |

When input has several problems, the first one in schema order is reported.

Entity and state errors:

| Situation | Code |
|---|---|
| Candidate, job or interview ID not found | `CANDIDATE_NOT_FOUND`, `JOB_NOT_FOUND`, `INTERVIEW_NOT_FOUND` |
| `record_interview_event` on a completed interview | `INTERVIEW_NOT_ACTIVE` |
| `finish_interview` on a completed interview | `INTERVIEW_ALREADY_COMPLETED` |
| Candidate name already in use | `DUPLICATE_RESOURCE` |

Storage errors:

| Situation | Code | Retryable |
|---|---|---|
| SQLite busy or locked after the busy timeout | `STORAGE_UNAVAILABLE` | yes |
| Any other SQLite error | `DATABASE_ERROR` | no |
| Any other unexpected exception | `INTERNAL_ERROR` | no |

All other codes are not retryable. `CONFLICT` from the initial design's list is
reserved and unused in v1. Messages for storage and internal errors are fixed
strings; SQL text, file paths and stack traces never reach the response.

## 8. Privacy and logging

- Logging goes to stderr only (stdout is the protocol channel).
- A log line contains at most: tool name, entity IDs, error code, duration.
  Never resume text, question or answer text, evidence, or evaluation content.
- Every lookup that takes two IDs checks they belong together (job to candidate,
  interview to candidate).
- No secrets are accepted as tool arguments; the only configuration is
  `COACH_DB_PATH`.

## 9. Testing

`vitest`, each test on a fresh in-memory database, calling handlers directly.

- Per tool: one happy path, plus each failure listed for it in sections 6 and 7.
- Envelope: a valid call, an invalid call, and a handler that throws an
  unexpected error all produce a well-formed envelope with the right `isError`.
- No hidden mutations: after `record_interview_event` and after
  `finish_interview`, `skill_assessments` and `skill_assessment_history` are
  unchanged.
- Atomicity: an `update_skill_assessment` batch with one invalid entry writes
  nothing.
- Immutability: a direct SQL `UPDATE` or `DELETE` on `interview_events` fails.
- State machine: finishing twice fails; recording after finish fails.
- One end-to-end test through an in-process MCP client: create candidate, create
  job, create interview, record events, update skills, finish, then
  `get_interview_context` returns all of it.

## 10. Running it

`npm run build` compiles to `dist/`; the server starts with `node dist/index.js`.
The README documents registering it with Claude Code
(`claude mcp add interview-coach -- node <path>/dist/index.js`) and the
`COACH_DB_PATH` variable.
