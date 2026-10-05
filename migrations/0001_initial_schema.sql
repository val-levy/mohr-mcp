CREATE TABLE candidates (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL COLLATE NOCASE UNIQUE,
  resume      TEXT NOT NULL DEFAULT '',
  profile     TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE jobs (
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
CREATE INDEX jobs_by_candidate ON jobs(candidate_id);

CREATE TABLE interviews (
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
CREATE INDEX interviews_by_candidate ON interviews(candidate_id);

CREATE TABLE interview_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  interview_id  TEXT NOT NULL REFERENCES interviews(id),
  type          TEXT NOT NULL,
  data          TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX events_by_interview ON interview_events(interview_id);

CREATE TRIGGER interview_events_no_update
BEFORE UPDATE ON interview_events
BEGIN
  SELECT RAISE(ABORT, 'interview_events is append-only');
END;

CREATE TRIGGER interview_events_no_delete
BEFORE DELETE ON interview_events
BEGIN
  SELECT RAISE(ABORT, 'interview_events is append-only');
END;

CREATE TABLE skill_assessments (
  candidate_id  TEXT NOT NULL REFERENCES candidates(id),
  skill         TEXT NOT NULL,
  score         REAL NOT NULL,
  confidence    REAL NOT NULL,
  evidence      TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (candidate_id, skill)
);

CREATE TABLE skill_assessment_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id  TEXT NOT NULL REFERENCES candidates(id),
  skill         TEXT NOT NULL,
  score         REAL NOT NULL,
  confidence    REAL NOT NULL,
  evidence      TEXT NOT NULL,
  interview_id  TEXT REFERENCES interviews(id),
  created_at    TEXT NOT NULL
);
CREATE INDEX skill_history_by_candidate ON skill_assessment_history(candidate_id);
