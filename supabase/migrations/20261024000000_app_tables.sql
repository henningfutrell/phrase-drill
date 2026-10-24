-- The four app tables, in the shape the server's own `init()` creates them
-- (server/db.js, server/clip-job-store.js). `IF NOT EXISTS` like `init()`, so
-- this changes nothing on a database that already has them: at cutover
-- `migration/supabase/001_schema.sql` has made them first, with the
-- migration-only columns that `clips-to-storage.mjs --finalize` removes.
-- It exists so a fresh database (`npx supabase start`, `supabase db reset`)
-- has the tables before the hardening migration after it runs.

CREATE TABLE IF NOT EXISTS libraries (
  library_key TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS library_versions (
  id BIGSERIAL PRIMARY KEY,
  library_key TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  archived_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS library_versions_key_idx ON library_versions (library_key, id DESC);

CREATE TABLE IF NOT EXISTS clips (
  hash TEXT PRIMARY KEY,
  storage_path TEXT NOT NULL,
  mime TEXT NOT NULL,
  duration_ms BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  byte_size BIGINT NOT NULL,
  last_used_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS clip_jobs (
  hash TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  voice_id TEXT NOT NULL,
  lang TEXT NOT NULL,
  text TEXT NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  billed_calls INTEGER NOT NULL,
  window_started_at BIGINT NOT NULL,
  next_attempt_at BIGINT NOT NULL,
  last_error_kind TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
