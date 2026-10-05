-- Sample data for trying the server out. Loaded only by `npm run db:seed`, never on startup.
-- Every statement must be safe to run twice.

INSERT OR IGNORE INTO candidates (id, name, resume, profile, version, created_at, updated_at)
VALUES (
  'cand_demo',
  'Demo Candidate',
  'Third-year computer science student. Built a distributed key-value store and a campus events app.',
  '{"experience":[{"title":"Software Engineering Intern","organization":"Example Corp","description":"Built internal data tooling."}],"projects":[{"name":"kvstore","description":"A replicated key-value store using Raft.","technologies":["Go"]}],"skills":["Go","Python","SQL"],"interests":["distributed systems"],"preferences":["prefers hints before full solutions"]}',
  1,
  '2026-01-01T00:00:00.000Z',
  '2026-01-01T00:00:00.000Z'
);

INSERT OR IGNORE INTO jobs (id, candidate_id, company, title, description, location, requirements, metadata, created_at)
VALUES (
  'job_demo',
  'cand_demo',
  'Example Corp',
  'Software Engineer Intern',
  'Work on the data platform team building pipelines and storage services.',
  'Remote',
  '["Data structures and algorithms","One systems language","SQL"]',
  '{}',
  '2026-01-01T00:00:00.000Z'
);
