# Interview Coach MCP — Hosted Service Design Spec

Date: 2026-10-05
Builds on: `2026-10-05-interview-coach-mcp-design.md` (the "v1 spec"). Everything in the
v1 spec still holds unless this document changes it. Section 3 lists every change.

## 1. Purpose

Turn the local, single-user server into a hosted service that students reach from
Claude by adding one URL and signing in with Google. No install, no terminal.

The audience is students moving into technical roles from less technical backgrounds.
They will not install Node or edit a config file, so the download-and-run version is
retired.

The boundary rule is unchanged: the AI model does all reasoning; the server validates,
stores and retrieves.

Success: a student adds the connector in Claude on the web, signs in with Google, runs
an interview, and in a later conversation on another device finds the same profile, jobs,
history and skill model. A second student signed in to the same server can never read or
change anything belonging to the first.

## 2. Scope

In scope:

- Streamable HTTP transport in place of stdio
- Google sign-in through Supabase Auth; every request authenticated
- An account per signed-in student; every row owned by an account
- Postgres (Supabase) in place of SQLite
- 15 tools: the 13 from v1, plus `delete_candidate` and `list_interview_events`
- Paging on list tools, caps on the interview context, per-account limits
- A sign-in and approval page and an account page with "delete my account"
- A container image with health checks

Out of scope: billing and paywalls, a progress dashboard, interviews run on the website,
an instructor or institution view, sign-in methods other than Google, a local SQLite
mode, down-migrations, idempotency keys. The `accounts` table exists so billing can
attach later without reshaping data.

Clients: Claude (web, desktop, mobile) is the supported client and the acceptance target.
ChatGPT can connect to the same server, since it speaks the same protocol, but it needs a
paid plan and Developer Mode there, so it is not promoted or part of acceptance.

## 3. Changes from the v1 spec

| # | v1 | Hosted | Reason |
|---|---|---|---|
| 1 | stdio transport | Streamable HTTP, stateless | Reachable from Claude on the web and mobile; any number of instances |
| 2 | No authentication | Bearer token on every request, issued by Supabase Auth | Many students share one server |
| 3 | No owner on data | `account_id` on every table; every query scoped by it; row security in the database | One student must never reach another's data |
| 4 | SQLite file on the user's disk | Postgres | Concurrent users, managed backups |
| 5 | Migrations run at startup | Migrations run by `npm run db:migrate` at deploy; startup only verifies | Several instances must not race to migrate; a bad migration must not take serving instances down |
| 6 | Synchronous handlers `(db, input)` | Async handlers `(ctx, input)`, one transaction per tool call | Postgres access is asynchronous; one transaction makes every read consistent |
| 7 | Candidate name unique across the database | Unique per account | Two students may share a name |
| 8 | No delete tools | `delete_candidate`; account deletion on the web page | Hosting personal data requires a way to remove it |
| 9 | No paging | `limit` and `cursor` on list tools; caps on `get_interview_context` | Responses must stay bounded as history grows |
| 10 | Logs to stderr | JSON lines to stdout | stdout is no longer the protocol channel; hosts collect stdout |
| 11 | DB file permissions, first-start busy retry | Removed | They only concern a file on the user's disk |

## 4. Architecture

```
Claude ──HTTPS──▶ MCP server (Node, stateless, N instances)
   │                 │  verifies token against Supabase public keys
   │                 └──▶ Supabase Postgres (data, row security)
   └──browser──▶ /authorize page ──▶ Supabase Auth (Google sign-in, issues tokens)
```

Stack: TypeScript on Node 24, `@modelcontextprotocol/sdk`, `zod`, Express 5 (already a
dependency of the SDK), `pg`, `jose` for token verification, `@electric-sql/pglite` for
tests, `vitest`.

### 4.1 How a student connects

1. The student adds `https://<host>/mcp` as a custom connector in Claude.
2. Claude calls `/mcp` without a token and receives `401` with a pointer to
   `/.well-known/oauth-protected-resource`, which names Supabase Auth as the
   authorization server.
3. Claude registers itself with Supabase Auth (dynamic client registration) and opens
   the student's browser at the authorization page.
4. The page (`/authorize`, served by this service) signs the student in with Google if
   needed, shows which app is asking for access, and lets them approve or deny.
5. Supabase Auth issues Claude an access token and a refresh token.
6. Every later request carries `Authorization: Bearer <token>`.

The server never sees a Google credential or a password and stores no tokens.

### 4.2 HTTP surface

| Route | Purpose |
|---|---|
| `POST /mcp` | The MCP endpoint. JSON request, JSON response. Requires a valid token. |
| `GET /mcp`, `DELETE /mcp` | `405`. The server is stateless: no sessions, no server-initiated streams. |
| `GET /.well-known/oauth-protected-resource` and `.../oauth-protected-resource/mcp` | Resource metadata: this server's URL and the Supabase authorization server. |
| `GET /authorize` | Sign-in and approval page. |
| `GET /account` | Account page: who is signed in, and "delete my account". |
| `DELETE /account` | Deletes the caller's account and all its data. Requires a valid token. |
| `GET /healthz` | Liveness: `200` if the process is up. |
| `GET /readyz` | Readiness: `200` only if the database answers and the schema is current. |

Each `POST /mcp` builds a fresh protocol server and transport for that one request and
discards them afterwards, so instances share nothing and can be added or removed freely.
Request bodies over 1 MB are rejected with `413`.

### 4.3 Authentication

For every request to `/mcp` and `DELETE /account`:

1. Read the bearer token. Missing or malformed: `401` with
   `WWW-Authenticate: Bearer resource_metadata="<url>"`.
2. Verify the signature against Supabase's published public keys (cached, refreshed on
   an unknown key ID), and check issuer, expiry, and that the `role` claim is
   `authenticated`. Any failure: `401`, same header.
3. The token's `sub` claim is the account ID.

The Supabase project must use asymmetric signing keys so the server verifies tokens
without holding a secret that could mint them.

Authentication failures are HTTP responses, not tool envelopes: the client needs the
`401` to start or refresh sign-in. Everything after authentication uses the envelope.

### 4.4 Code layout

```
src/main.ts              entry: config, pool, HTTP app, graceful shutdown
src/migrate.ts           CLI entry for `npm run db:migrate`
src/seed.ts              CLI entry for `npm run db:seed` (refuses in production)
src/registry.ts          the tool list
src/config.ts            reads and validates environment variables once
src/core/                envelope, errors, primitives, paths, server, pagination
src/http/                app (routes), auth (token check), metadata, account, rate-limit
src/storage/             database (pool, account-scoped transaction), migrator, seeder
src/accounts/            ensure-account, delete-account
src/{candidates,jobs,interviews,skills}/   schemas.ts + tools.ts, as today
db/migrations/           Postgres SQL, numbered
db/seeds/                development sample data
web/                     authorize and account pages: plain HTML, CSS and JS files
prompts/                 server instructions
Dockerfile
```

No SQL, HTML or prompt text lives inside a TypeScript file.

### 4.5 Handler contract

```ts
type Ctx = { db: Tx; accountId: string };
type Handler<I, O> = (ctx: Ctx, input: I) => Promise<O>;
```

`callTool(pool, accountId, name, rawArgs)` does, in order: rate-limit check, parse input
with the tool's schema, open one transaction scoped to the account (section 5.2), make
sure the account row exists, run the handler, commit, build the envelope. A thrown error
rolls the transaction back. Handlers still know nothing about HTTP or MCP.

## 5. Data

### 5.1 Schema

The SQLite migration is replaced by a Postgres `0001_initial_schema.sql`. The v1 branch
was never released, so there is no data to carry over.

Type changes: JSON text becomes `jsonb`; timestamps become `timestamptz` (still returned
as ISO 8601 UTC strings with milliseconds); event and history IDs become
`bigint GENERATED ALWAYS AS IDENTITY`. Tool outputs keep the v1 shapes.

```
accounts
    id            uuid PRIMARY KEY      (the token's sub; Supabase user ID)
    created_at    timestamptz NOT NULL
    last_seen_at  timestamptz NOT NULL

candidates        + account_id uuid NOT NULL REFERENCES accounts ON DELETE CASCADE
                  UNIQUE (account_id, name_key)      (replaces UNIQUE (name_key))
jobs, interviews, interview_events,
skill_assessments, skill_assessment_history
                  + account_id uuid NOT NULL REFERENCES accounts ON DELETE CASCADE
                  existing foreign keys gain ON DELETE CASCADE
```

`account_id` is stored on every table, not only on `candidates`, so each row security
policy is a single equality check and each table can be indexed and, later, partitioned
by account. Child rows must carry the same `account_id` as their parent; composite
foreign keys `(account_id, candidate_id)` enforce it.

Indexes: `(account_id, updated_at DESC, id)` on candidates; `(candidate_id, created_at
DESC, id)` on jobs; `(candidate_id, started_at DESC, id)` on interviews;
`(interview_id, id)` on events; `(candidate_id, id)` on skill history.

### 5.2 Isolation, in two layers

Layer 1, in code: every query a handler runs includes `account_id = $accountId`. A row
belonging to another account is indistinguishable from one that does not exist: the tool
returns the same `*_NOT_FOUND` error with the same message.

Layer 2, in the database: the server connects as `coach_app`, a role that does not own
the tables and cannot bypass row security. Every table has row security enabled with one
policy: `account_id = current_setting('app.account_id')::uuid`. Each transaction starts
with `SELECT set_config('app.account_id', $1, true)`, which lasts only for that
transaction, so it is safe behind a connection pooler. A query that forgets layer 1
still returns only the caller's rows; a transaction that never set the account returns
none.

Migrations run as the table owner over a separate connection string that the serving
process never receives.

### 5.3 Append-only data

`coach_app` is granted only `SELECT` and `INSERT` on `interview_events` and
`skill_assessment_history`, and a trigger rejects `UPDATE` on both. Rows leave those
tables only by cascade when their candidate or account is deleted.

### 5.4 Migrations and seeds

The migrator keeps its rules: numbered files, SHA-256 checksums, one transaction per
migration, refusal on an edited, missing or out-of-order file. Two changes:

- It runs only from `npm run db:migrate`, holding a Postgres advisory lock so two
  deploys cannot migrate at once.
- At startup the server compares `schema_migrations` with the files it shipped with and
  exits with a one-line error if they differ. It never changes the schema itself.

`npm run db:seed` loads `db/seeds/` under a fixed development account ID and refuses to
run when `NODE_ENV=production`.

## 6. Tools

All 13 v1 tools keep their names, inputs and outputs, with these changes.

Ownership: every tool acts only within the caller's account. No tool takes an account ID
as input; it always comes from the token.

Paging, on `list_candidates`, `list_target_jobs`, `list_interviews`: optional
`limit` (integer 1–100, default 50) and optional `cursor` (opaque string from a previous
response). The response gains `next_cursor`, a string or `null` when there is nothing
more. Ordering is unchanged from v1, with the ID as tie-breaker so paging is stable. A
cursor that cannot be decoded is `INVALID_CURSOR`.

**`get_interview_context`** — `previous_events` holds the most recent 200 events, oldest
first, with `events_truncated: boolean`. `skill_history.history` holds the most recent
200 entries, oldest first, with `history_truncated: boolean`. Everything else is as v1.
All reads happen in one transaction.

**`list_interview_events`** (new) — input `{ interview_id, limit?, cursor? }`. Returns
`{ events: [...], next_cursor }`, oldest first, same event shape as in the context. This
is how a client reads past the 200-event cap.

**`delete_candidate`** (new) — input `{ candidate_id, confirm_name }`. `confirm_name`
must equal the candidate's name ignoring case, otherwise `INVALID_INPUT` on
`confirm_name` and nothing is deleted. Deletes the candidate and, by cascade, their jobs,
interviews, events and skill data. Returns `{ candidate_id, deleted: true }`. The
confirmation exists so a model cannot delete a profile from an ID alone; the server
instructions tell it to ask the student first.

### 6.1 Limits

Per account, enforced in the tool that would exceed them, error `LIMIT_EXCEEDED`:

| Limit | Value |
|---|---|
| Candidates | 10 |
| Jobs per candidate | 200 |
| Active interviews per candidate | 20 |
| Events per interview | 5,000 |

Rate limit: 120 tool calls per minute per account, error `RATE_LIMITED` (retryable). The
counter is held in memory per instance, so with N instances the effective ceiling is up
to N times higher. That is accepted: the limit exists to stop runaway loops, not to
meter usage.

### 6.2 New error codes

| Code | Retryable | When |
|---|---|---|
| `RATE_LIMITED` | yes | More than 120 calls in a minute |
| `LIMIT_EXCEEDED` | no | A limit in 6.1 would be exceeded |
| `INVALID_CURSOR` | no | `cursor` is not one this server issued for this tool |

`STORAGE_UNAVAILABLE` (retryable) now covers a failed or timed-out database connection
and a serialization or deadlock failure. Other database errors remain `DATABASE_ERROR`.

### 6.3 Server instructions

`prompts/server_instructions.md` is revised to name no particular AI model, to say that
a profile is deleted only after the student confirms by name, and to mention
`list_interview_events` for long interviews. The workflow is otherwise unchanged.

## 7. Web pages

Plain HTML, CSS and JavaScript files in `web/`, served by the same service. They use the
Supabase browser client with the project's public key.

- `/authorize`: if not signed in, a "Continue with Google" button. Once signed in, shows
  the name of the app requesting access and Approve and Deny buttons, then returns the
  student to that app.
- `/account`: shows the signed-in email, a sign-out button, and "Delete my account" with
  a typed confirmation.

`DELETE /account` deletes the `accounts` row (cascading to everything the student
stored), then removes the user from Supabase Auth using the service key. If the second
step fails the response is an error and the page says so; the data is already gone and
the student can retry to remove the sign-in record.

## 8. Configuration

Read once at startup by `src/config.ts`; a missing or malformed value stops startup with
a one-line error naming the variable.

| Variable | Used by | Meaning |
|---|---|---|
| `PORT` | server | Listening port, default 8080 |
| `PUBLIC_URL` | server | The service's own HTTPS origin, used in metadata |
| `SUPABASE_URL` | server, pages | The Supabase project URL |
| `SUPABASE_PUBLISHABLE_KEY` | pages | Public key for the browser client |
| `SUPABASE_SERVICE_KEY` | server | Secret, used only to remove a user on account deletion |
| `DATABASE_URL` | server | Connection string for `coach_app` |
| `MIGRATION_DATABASE_URL` | `db:migrate`, `db:seed` | Connection string for the table owner |

No secret is ever accepted as a tool argument, written to a log, or sent to a page.

## 9. Privacy, logging and operations

- One JSON log line per tool call to stdout: request ID, account ID, tool, success,
  error code, duration. Never arguments, results, tokens, emails or names.
- One line per failed authentication: request ID and reason, never the token.
- Students can delete a profile from the chat and their whole account from the web page.
- Shutdown on `SIGTERM`: stop accepting connections, finish requests in flight for up to
  10 seconds, close the pool.
- The container runs as a non-root user and contains `dist/`, `db/`, `prompts/`, `web/`
  and production dependencies only.
- Deploy order: run `db:migrate`, then start the new instances. `/readyz` keeps an
  instance out of rotation until the schema matches.

The hosting provider is not chosen here; anything that runs a container and routes HTTPS
to it will do.

## 10. Testing

Tests run against an in-process Postgres (PGlite), one fresh database per test, with the
shipped migrations applied and queries run as `coach_app`. No Docker or network.

- Every v1 tool test is kept and adapted to the async contract and an account.
- Isolation, for every tool that takes an ID: called by account B with account A's ID, it
  returns the same error as for an ID that does not exist, and A's data is unchanged.
  Every list tool returns only the caller's rows.
- Row security: a query run as `coach_app` with no `account_id` filter returns only the
  current account's rows, and none when no account is set.
- Append-only: `UPDATE` and `DELETE` on events and history fail as `coach_app`; deleting
  a candidate removes their events.
- Paging: walking a list with `limit` 2 visits every row once, in order; a tampered
  cursor is `INVALID_CURSOR`.
- Limits and rate limit: the call that would exceed each limit fails and writes nothing.
- Authentication, through the real HTTP app with a locally generated key pair standing
  in for Supabase: no token, a bad signature, an expired token, the wrong issuer and the
  wrong role each give `401` with the metadata header; a good token reaches the tool.
- Account deletion removes every row for that account and none for another.
- Migrator: the existing rules, plus that two concurrent runs apply each migration once.
- One end-to-end test through an MCP client over HTTP: the full interview flow of v1.

## 11. To prove before building on it

Two assumptions carry the design. The plan's first task tests both, and the result comes
back for a decision before anything else is built.

1. **Claude's connector completes sign-in against Supabase Auth.** Supabase documents
   this use, but the exact exchange (client registration, and the resource indicator
   Claude sends) has to be seen working end to end with a throwaway server. If it does
   not work, the fallback is for this service to front Supabase's sign-in endpoints
   using the SDK's OAuth proxy, which adds code but keeps Supabase and Google.
2. **PGlite enforces row security for a non-owner role.** If it does not, the row
   security tests run against a local Supabase stack instead, and the rest stay on
   PGlite.

## 12. Running it

`npm run build`, `npm run db:migrate`, `npm start`. The README covers: creating the
Supabase project, enabling Google sign-in and the OAuth server with dynamic client
registration, creating the `coach_app` role, the environment variables, building and
running the container, and adding the connector in Claude.
