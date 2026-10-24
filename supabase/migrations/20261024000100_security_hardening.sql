-- Locks the database to the server. Replaces `migration/supabase/004_rls.sql`.
--
-- The server is the only database client. It connects as `postgres`, which
-- owns these tables, and an owner bypasses row level security (RLS is not
-- FORCEd, on purpose). The device never talks to the database: it calls the
-- server's `/api/*` with a Supabase access token. So `anon` and
-- `authenticated` (the roles the Data API acts as) get no grant on anything
-- here, and the Data API is switched off in the dashboard as well.
--
-- The policies are a second wall, not the first: with no grant they admit
-- nobody. If a grant is ever added by mistake, a signed-in user still sees
-- only the rows of their own library (`library_key` is their Supabase user
-- id), and the shared Clip cache stays closed to every API role.
--
-- Idempotent: cutover.sh applies it before the data and again after
-- `--finalize`. Apply: psql -X -v ON_ERROR_STOP=1 --single-transaction -f <this file>

-- 1. RLS on every app table.
ALTER TABLE libraries        ENABLE ROW LEVEL SECURITY;
ALTER TABLE library_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE clips            ENABLE ROW LEVEL SECURITY;
ALTER TABLE clip_jobs        ENABLE ROW LEVEL SECURITY;

-- 2. Per-user policies. A library and its archived versions belong to one
-- user. Versions are written only by the server (on every PUT), so the policy
-- reads them and nothing more. `(select auth.uid())` is evaluated once per
-- statement, not once per row.
DROP POLICY IF EXISTS libraries_own_rows ON libraries;
CREATE POLICY libraries_own_rows ON libraries
  FOR ALL TO authenticated
  USING (library_key = (select auth.uid())::text)
  WITH CHECK (library_key = (select auth.uid())::text);

DROP POLICY IF EXISTS library_versions_own_rows ON library_versions;
CREATE POLICY library_versions_own_rows ON library_versions
  FOR SELECT TO authenticated
  USING (library_key = (select auth.uid())::text);

-- `clips` and `clip_jobs` are one cache shared by every user, keyed by the
-- content hash of a Clip, not by user. No row in them belongs to a user, so
-- there is no per-user policy to write: no policy is a refusal of every row.

-- 3. Minimal grants: nothing for the API roles, now or for objects made later.
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM PUBLIC, anon, authenticated;

-- 4. Refuse to finish on a hole. The app has no functions today; this is what
-- keeps a later one SECURITY INVOKER with a fixed search_path, and every
-- later table under RLS with no API grant.
DO $$
DECLARE
  problems text;
BEGIN
  SELECT string_agg(problem, '; ' ORDER BY problem) INTO problems FROM (
    SELECT format('table %I has RLS off', c.relname) AS problem
    FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity
    UNION ALL
    SELECT format('table %I is granted %s to %s', c.relname, p.privilege, r.rolname)
    FROM pg_class c
    CROSS JOIN (VALUES ('anon'), ('authenticated')) AS r (rolname)
    CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p (privilege)
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm')
      AND has_table_privilege(r.rolname, c.oid, p.privilege)
    UNION ALL
    SELECT format('function %s is SECURITY DEFINER', f.oid::regprocedure)
    FROM pg_proc f
    WHERE f.pronamespace = 'public'::regnamespace AND f.prosecdef
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = f.oid AND d.deptype = 'e')
    UNION ALL
    SELECT format('function %s has no fixed search_path', f.oid::regprocedure)
    FROM pg_proc f
    WHERE f.pronamespace = 'public'::regnamespace
      AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(f.proconfig, '{}')) AS setting WHERE setting LIKE 'search_path=%')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = f.oid AND d.deptype = 'e')
  ) AS found;
  IF problems IS NOT NULL THEN
    RAISE EXCEPTION 'security hardening refused: %', problems;
  END IF;
END
$$;
