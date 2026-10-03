-- Run after 002_data.sh. The live database predates `last_used_at`, so COPY
-- left it NULL; `byte_size` may be NULL on rows from before it existed.
-- Apply: psql -v ON_ERROR_STOP=1 "$SUPABASE_DB_URL" -f 003_fixup.sql
BEGIN;
UPDATE clips SET last_used_at = created_at WHERE last_used_at IS NULL;
UPDATE clips SET byte_size = octet_length(bytes) WHERE byte_size IS NULL;
ALTER TABLE clips ALTER COLUMN byte_size SET NOT NULL;
ALTER TABLE clips ALTER COLUMN last_used_at SET NOT NULL;
COMMIT;
