-- Sample data for development. Loaded only by `npm run db:seed`, never on startup and never in
-- production. Every statement must be safe to run twice.
-- Everything belongs to one fixed development account.

INSERT INTO accounts (id, created_at, last_seen_at)
VALUES ('00000000-0000-4000-8000-000000000001', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
ON CONFLICT DO NOTHING;

INSERT INTO candidates (id, account_id, name, name_key, resume, profile, version, created_at, updated_at)
VALUES (
  'cand_demo',
  '00000000-0000-4000-8000-000000000001',
  'Demo Candidate',
  'demo candidate',
  'Third-year computer science student. Built a distributed key-value store and a campus events app.',
  '{"experience":[{"title":"Software Engineering Intern","organization":"Example Corp","description":"Built internal data tooling."}],"projects":[{"name":"kvstore","description":"A replicated key-value store using Raft.","technologies":["Go"]}],"skills":["Go","Python","SQL"],"interests":["distributed systems"],"preferences":["prefers hints before full solutions"]}',
  1,
  '2026-01-01T00:00:00.000Z',
  '2026-01-01T00:00:00.000Z'
)
ON CONFLICT DO NOTHING;

INSERT INTO jobs (id, account_id, candidate_id, company, title, description, location, requirements, metadata, created_at)
VALUES (
  'job_demo',
  '00000000-0000-4000-8000-000000000001',
  'cand_demo',
  'Example Corp',
  'Software Engineer Intern',
  'Work on the data platform team building pipelines and storage services.',
  'Remote',
  '["Data structures and algorithms","One systems language","SQL"]',
  '{}',
  '2026-01-01T00:00:00.000Z'
)
ON CONFLICT DO NOTHING;
