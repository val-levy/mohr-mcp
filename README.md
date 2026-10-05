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

The database lives at `~/.interview-coach/coach.db`, readable only by your
user. Set `COACH_DB_PATH` to use a different file:

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

## Layout

| Path | Contents |
|---|---|
| `src/` | TypeScript only: server wiring, tools, validation |
| `migrations/` | The database schema, as numbered SQL files |
| `prompts/` | The instructions the server sends to Claude |
| `tests/` | The test suite |

## Changing the schema

Add a new file to `migrations/` named `NNNN_description.sql` with the next
number. The server applies pending migrations on startup, each in its own
transaction, and records them in the `schema_migrations` table. Never edit a
migration that has already been applied; write a new one.

## Development

```bash
npm test          # run the test suite
npm run typecheck # type-check src and tests
```
