# Interview Coach

A hosted MCP server that gives an AI assistant a memory for running technical
interviews. The assistant is the interviewer; this service stores each person's
candidates, target jobs, interviews, the record of each interview, and skill
assessments. People sign in with Google and add the service to their assistant
as a connector. Nobody can read anyone else's data.

Design: `docs/superpowers/specs/2026-10-05-hosted-interview-coach-design.md`.

## How it fits together

| Piece | Role |
| --- | --- |
| This service | Serves MCP over HTTP at `/mcp`, the sign-in consent page at `/authorize`, and the account page at `/account`. Stateless: run as many copies as you like. |
| Supabase Auth | Signs people in with Google and issues the tokens the assistant sends with every request. |
| Supabase Postgres | Stores everything. Row security keeps each account's rows invisible to every other account, in addition to the account filter in every query. |

The service never changes the database schema. Migrations are a separate
command run with a separate, more privileged connection.

## Requirements

- Node 24 or newer
- A Supabase project
- A Google OAuth client (Google Cloud Console)
- A public HTTPS address for the service

## Configuration

All configuration is environment variables. The server refuses to start and
names every missing or malformed variable.

| Variable | Used by | Meaning |
| --- | --- | --- |
| `PUBLIC_URL` | server | Where the service is reachable, e.g. `https://coach.example.com`. No trailing slash. |
| `PORT` | server | Port to listen on. Default `8080`. |
| `SUPABASE_URL` | server | `https://<project-ref>.supabase.co` |
| `SUPABASE_PUBLISHABLE_KEY` | server | The project's publishable key. Sent to browsers. |
| `SUPABASE_SERVICE_KEY` | server | The project's secret key. Used only to remove a person's sign-in when they delete their account. |
| `DATABASE_URL` | server | Connection string of the `coach_app` role (see below). |
| `MIGRATION_DATABASE_URL` | `db:migrate`, `db:seed` | Connection string of the database owner. Never give this to the server. |

## Set up Supabase

1. **Create the project** and note its URL, publishable key and secret key
   (Project Settings → API).
2. **Enable Google sign-in**: Authentication → Sign In / Providers → Google.
   Paste the client ID and secret of your Google OAuth client. In Google Cloud
   Console, add `https://<project-ref>.supabase.co/auth/v1/callback` as an
   authorised redirect URI.
3. **Allow the service's pages to finish sign-in**: Authentication → URL
   Configuration. Set the site URL to `PUBLIC_URL` and add
   `<PUBLIC_URL>/authorize` and `<PUBLIC_URL>/account` to the redirect URLs.
4. **Turn on the OAuth server**: Authentication → OAuth Server. Enable it,
   allow dynamic client registration, and set the authorization path to
   `<PUBLIC_URL>/authorize`. Make sure the project signs tokens with an
   asymmetric key (Authentication → Signing Keys); the server rejects tokens
   signed with a shared secret.
5. **Create the schema**:

   ```bash
   npm install
   npm run build
   MIGRATION_DATABASE_URL='postgresql://postgres.<project-ref>:<password>@<pooler-host>:5432/postgres' npm run db:migrate
   ```

   Use the session-mode connection (port 5432), not the transaction pooler:
   migrations take an advisory lock.
6. **Let the serving role log in.** The migration creates `coach_app` without
   a password. In the SQL editor, once:

   ```sql
   ALTER ROLE coach_app LOGIN PASSWORD '<a long random password>';
   ```

   `DATABASE_URL` is then the same connection string with that role. Through
   Supabase's pooler the user name carries the project reference:
   `postgresql://coach_app.<project-ref>:<password>@<pooler-host>:5432/postgres`.

Connections should verify the database's certificate. Download the project's
CA certificate (Project Settings → Database → SSL) and add
`?sslmode=verify-full&sslrootcert=/path/to/ca.crt` to both connection strings.

## Run

```bash
npm run build
npm start
```

or with the container image, which runs as an unprivileged user:

```bash
docker build -t interview-coach .
docker run --env-file .env -p 8080:8080 interview-coach
# Migrations, from the same image:
docker run --env MIGRATION_DATABASE_URL=... interview-coach node dist/migrate.js
```

Run migrations before starting a new version. A server whose migrations are
not applied, or whose applied migrations differ from the ones it ships with,
refuses to start and reports `503` from `/readyz`.

| Route | Purpose |
| --- | --- |
| `POST /mcp` | The MCP endpoint. Requires a bearer token. |
| `GET /.well-known/oauth-protected-resource` | Tells assistants where to sign in. |
| `GET /authorize` | Consent page shown during sign-in. |
| `GET /account`, `DELETE /account` | Account page; deletes all of a person's data and their sign-in. |
| `GET /healthz` | Process is up. |
| `GET /readyz` | Database is reachable and its schema is current. |

Tokens must be issued by the project, signed with an asymmetric key, and name
the audience `authenticated` or this service's address. Deleting an account is
only possible from the account page: a token issued to a connected app is
refused. Once an account is deleted its ID is kept, and nothing else, so that a
token issued before the deletion cannot start the account again.

The server logs one JSON object per line to stdout: request ID, account ID,
route or tool name, outcome, duration. It never logs tool arguments, results,
tokens or email addresses.

## Connect an assistant

In Claude: Settings → Connectors → Add custom connector, and enter
`<PUBLIC_URL>/mcp`. Claude opens the sign-in page; after Google sign-in and
consent, the tools are available. Then say something like "I'm preparing for a
software engineering internship interview; here is my resume and the job
posting."

## Tools

| Tool | Purpose |
| --- | --- |
| `create_candidate`, `get_candidate_profile`, `update_candidate_profile`, `list_candidates` | The people being coached. |
| `delete_candidate` | Permanently deletes a candidate and everything recorded for them. Requires the candidate's name as confirmation. |
| `create_target_job`, `get_target_job`, `list_target_jobs` | The jobs they are preparing for. |
| `create_interview`, `list_interviews`, `get_interview_context`, `finish_interview` | Interviews, and everything needed to resume one. |
| `record_interview_event`, `list_interview_events` | The append-only record of an interview. |
| `update_skill_assessment` | Scores per skill, with history. |

Every tool returns `{"success": true, "data": ...}` or
`{"success": false, "error": {code, message, field, retryable}}`. List tools
take `limit` (1–100, default 50) and `cursor`, and return `next_cursor`.

Limits per account: 10 candidates, 200 target jobs per candidate, 20 active
interviews per candidate, 5,000 events per interview, 120 tool calls per
minute. The rate limit is counted per server process.

## Develop

```bash
npm install
npm run typecheck
npm test
```

Tests run against an in-process Postgres (PGlite) and need no database or
network. To try the server against a local or scratch database, run
`npm run db:migrate` and then `npm run db:seed`, which loads the demo data in
`db/seeds/`. Seeding refuses to run when `NODE_ENV` is `production`.

### Layout

```
db/migrations/   Numbered SQL migrations. The only place schema lives.
db/bootstrap/    The migrator's own bookkeeping table.
db/seeds/        Demo data for development. Never loaded by migrating.
prompts/         Instructions the server gives the assistant.
web/             Sign-in, consent and account pages.
src/core/        Tool envelope, errors, limits, paging, rate limiting, logging.
src/storage/     Database access, migrator, seeder.
src/http/        HTTP app, token verification, discovery metadata.
src/accounts/    Account creation and deletion.
src/candidates/ src/jobs/ src/interviews/ src/skills/   One folder per feature.
```

### Changing the schema

Add a new file `db/migrations/NNNN_description.sql` with the next number. Never
edit a migration that has been applied anywhere: the migrator compares
checksums and refuses to run.
