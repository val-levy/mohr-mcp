-- The migrator's own record of what it has applied. It cannot be a numbered migration, because the
-- migrator reads it to decide which migrations to run; it is created before the first one.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     integer PRIMARY KEY,
  name        text NOT NULL,
  checksum    text NOT NULL,
  applied_at  timestamptz NOT NULL
);
