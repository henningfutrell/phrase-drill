-- Target schema for the Supabase project. Apply with:
--   psql -v ON_ERROR_STOP=1 "$SUPABASE_DB_URL" -f 001_schema.sql
-- Data only moves later (002_data.sh); the schema is written out, never pg_dump'd,
-- so a PG 18 dump cannot carry syntax an older Supabase Postgres rejects.

CREATE TABLE libraries (
  library_key TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE library_versions (
  id BIGSERIAL PRIMARY KEY,
  library_key TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  archived_at BIGINT NOT NULL
);
CREATE INDEX library_versions_key_idx ON library_versions (library_key, id DESC);

-- `bytes` and `storage_path` are nullable only for the move: `bytes` is dropped
-- and `storage_path` made NOT NULL by `clips-to-storage.mjs --finalize`;
-- `byte_size` and `last_used_at` are tightened by 003_fixup.sql.
CREATE TABLE clips (
  hash TEXT PRIMARY KEY,
  bytes BYTEA,
  storage_path TEXT,
  mime TEXT NOT NULL,
  duration_ms BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  byte_size BIGINT,
  last_used_at BIGINT
);

-- Copied verbatim from server/clip-job-store.js init(). Created empty: the
-- queue is transient and is not migrated.
CREATE TABLE clip_jobs (
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
