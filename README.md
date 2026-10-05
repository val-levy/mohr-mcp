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
claude mcp add interview-coach -- node /absolute/path/to/mohr-mcp/dist/main.js
```

Then start a conversation with something like "I'm preparing for a software
engineering internship interview at Palantir; here is my resume and the job
posting."

## Data

The database lives at `~/.interview-coach/coach.db`, readable only by your
user. Set `COACH_DB_PATH` to use a different file:

```bash
claude mcp add interview-coach -e COACH_DB_PATH=/path/to/coach.db -- node /absolute/path/to/mohr-mcp/dist/main.js
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

## Layout

| Path | Contents |
|---|---|
| `src/main.ts` | Entry point: opens the database, builds the server, connects stdio |
| `src/registry.ts` | The list of tools the server exposes |
| `src/core/` | Shared plumbing: server wiring, response envelope, errors, common schema types |
| `src/storage/` | Opening the database, the migrator, the seeder |
| `src/candidates/`, `src/jobs/`, `src/interviews/`, `src/skills/` | One folder per feature, each with its `schemas.ts` and `tools.ts` |
| `db/migrations/` | The database schema, as numbered SQL files |
| `db/seeds/` | Sample data, loaded only on request |
| `prompts/` | The instructions the server sends to Claude |
| `tests/` | The test suite |

## Changing the schema

Add a file to `db/migrations/` named `NNNN_description.sql` with the next
number. On startup the server applies pending migrations, each in its own
transaction, and records each one with a checksum in `schema_migrations`.

The server refuses to start if an applied migration has been edited or
deleted, if a new migration is numbered below one already applied, or if a
`.sql` file in that folder is not named like a migration. Never edit an applied
migration; write a new one.

## Sample data

```bash
npm run db:seed
```

This loads every file in `db/seeds/` into the database (the one at
`COACH_DB_PATH`, or the default). Seeds are never loaded on startup and are
not migrations. Nothing records that a seed ran, so each seed file must be
safe to load twice (`INSERT OR IGNORE`).

## Development

```bash
npm test          # run the test suite
npm run typecheck # type-check src and tests
```
