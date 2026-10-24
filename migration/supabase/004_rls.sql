-- Locks the Data API. The server is the only database client and connects as
-- the table owner, which bypasses RLS. Nothing is reachable with the public
-- anon/publishable key: RLS on, no policies, grants revoked.
-- Apply: psql -v ON_ERROR_STOP=1 "$SUPABASE_DB_URL" -f 004_rls.sql
BEGIN;
ALTER TABLE libraries        ENABLE ROW LEVEL SECURITY;
ALTER TABLE library_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE clips            ENABLE ROW LEVEL SECURITY;
ALTER TABLE clip_jobs        ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON libraries, library_versions, clips, clip_jobs FROM anon, authenticated;
COMMIT;
