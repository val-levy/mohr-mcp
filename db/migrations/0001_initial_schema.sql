-- The serving process works as coach_app: it owns nothing and cannot bypass row security.
-- Created without a password; an operator enables login once (see the README).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'coach_app') THEN
    CREATE ROLE coach_app NOLOGIN;
  END IF;
END
$$;
GRANT coach_app TO CURRENT_USER;

-- The account every statement in the current transaction acts for; NULL when none was set.
CREATE FUNCTION current_account_id() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.account_id', true), '')::uuid $$;

CREATE FUNCTION reject_update() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END
$$;

-- One row per signed-in person. id is the subject of their sign-in token.
CREATE TABLE accounts (
  id            uuid PRIMARY KEY,
  created_at    timestamptz NOT NULL,
  last_seen_at  timestamptz NOT NULL
);

CREATE TABLE candidates (
  id          text PRIMARY KEY,
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name        text NOT NULL,
  -- name folded for comparison (Unicode-normalised, lower case); enforces unique names ignoring case
  name_key    text NOT NULL,
  resume      text NOT NULL DEFAULT '',
  profile     jsonb NOT NULL,
  version     integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL,
  CONSTRAINT candidates_name_unique UNIQUE (account_id, name_key),
  CONSTRAINT candidates_account_id_unique UNIQUE (account_id, id)
);
CREATE INDEX candidates_by_account ON candidates (account_id, updated_at DESC, id DESC);

-- Child tables repeat account_id and reference their parent together with it, so a row can never
-- point at a parent in another account.
CREATE TABLE jobs (
  id            text PRIMARY KEY,
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  candidate_id  text NOT NULL,
  company       text NOT NULL,
  title         text NOT NULL,
  description   text NOT NULL,
  location      text,
  requirements  jsonb NOT NULL,
  metadata      jsonb NOT NULL,
  created_at    timestamptz NOT NULL,
  CONSTRAINT jobs_account_id_unique UNIQUE (account_id, id),
  FOREIGN KEY (account_id, candidate_id) REFERENCES candidates (account_id, id) ON DELETE CASCADE
);
CREATE INDEX jobs_by_candidate ON jobs (candidate_id, created_at DESC, id DESC);

CREATE TABLE interviews (
  id                text PRIMARY KEY,
  account_id        uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  candidate_id      text NOT NULL,
  job_id            text NOT NULL,
  type              text NOT NULL,
  status            text NOT NULL CHECK (status IN ('active', 'completed')),
  started_at        timestamptz NOT NULL,
  finished_at       timestamptz,
  overall_score     double precision,
  final_evaluation  jsonb,
  CONSTRAINT interviews_account_id_unique UNIQUE (account_id, id),
  FOREIGN KEY (account_id, candidate_id) REFERENCES candidates (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, job_id) REFERENCES jobs (account_id, id) ON DELETE CASCADE
);
CREATE INDEX interviews_by_candidate ON interviews (candidate_id, started_at DESC, id DESC);
CREATE INDEX interviews_by_job ON interviews (job_id);

CREATE TABLE interview_events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  interview_id  text NOT NULL,
  type          text NOT NULL,
  data          jsonb NOT NULL,
  created_at    timestamptz NOT NULL,
  FOREIGN KEY (account_id, interview_id) REFERENCES interviews (account_id, id) ON DELETE CASCADE
);
CREATE INDEX events_by_interview ON interview_events (interview_id, id);

CREATE TABLE skill_assessments (
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  candidate_id  text NOT NULL,
  skill         text NOT NULL,
  score         double precision NOT NULL,
  confidence    double precision NOT NULL,
  evidence      text NOT NULL,
  updated_at    timestamptz NOT NULL,
  PRIMARY KEY (candidate_id, skill),
  FOREIGN KEY (account_id, candidate_id) REFERENCES candidates (account_id, id) ON DELETE CASCADE
);

CREATE TABLE skill_assessment_history (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  candidate_id  text NOT NULL,
  skill         text NOT NULL,
  score         double precision NOT NULL,
  confidence    double precision NOT NULL,
  evidence      text NOT NULL,
  interview_id  text,
  created_at    timestamptz NOT NULL,
  FOREIGN KEY (account_id, candidate_id) REFERENCES candidates (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, interview_id) REFERENCES interviews (account_id, id) ON DELETE CASCADE
);
CREATE INDEX skill_history_by_candidate ON skill_assessment_history (candidate_id, id);
CREATE INDEX skill_history_by_interview ON skill_assessment_history (interview_id);

-- Events and skill history are a record of what happened: rows are added, never changed. They leave
-- only by cascade when their candidate or account is deleted, which runs with the owner's rights.
CREATE TRIGGER interview_events_no_update
BEFORE UPDATE ON interview_events
FOR EACH ROW EXECUTE FUNCTION reject_update();

CREATE TRIGGER skill_assessment_history_no_update
BEFORE UPDATE ON skill_assessment_history
FOR EACH ROW EXECUTE FUNCTION reject_update();

GRANT SELECT, INSERT, UPDATE, DELETE ON accounts, candidates, jobs, interviews, skill_assessments TO coach_app;
GRANT SELECT, INSERT ON interview_events, skill_assessment_history TO coach_app;

-- Second line of defence behind the account filter every query carries: coach_app can only see and
-- write rows of the account set for the current transaction, and none when no account is set.
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE interviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE interview_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE skill_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE skill_assessment_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY own_account ON accounts TO coach_app
  USING (id = current_account_id()) WITH CHECK (id = current_account_id());
CREATE POLICY own_rows ON candidates TO coach_app
  USING (account_id = current_account_id()) WITH CHECK (account_id = current_account_id());
CREATE POLICY own_rows ON jobs TO coach_app
  USING (account_id = current_account_id()) WITH CHECK (account_id = current_account_id());
CREATE POLICY own_rows ON interviews TO coach_app
  USING (account_id = current_account_id()) WITH CHECK (account_id = current_account_id());
CREATE POLICY own_rows ON interview_events TO coach_app
  USING (account_id = current_account_id()) WITH CHECK (account_id = current_account_id());
CREATE POLICY own_rows ON skill_assessments TO coach_app
  USING (account_id = current_account_id()) WITH CHECK (account_id = current_account_id());
CREATE POLICY own_rows ON skill_assessment_history TO coach_app
  USING (account_id = current_account_id()) WITH CHECK (account_id = current_account_id());

-- The migration log is created by the migrator before this file runs. The server reads it at
-- startup to check the schema is current; nobody else may read it.
ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;
CREATE POLICY read_log ON schema_migrations FOR SELECT TO coach_app USING (true);
GRANT SELECT ON schema_migrations TO coach_app;
