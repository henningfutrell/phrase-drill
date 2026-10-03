-- Run on BOTH sides, with `psql -X -At -f 005_verify.sql`; the outputs must be
-- identical. Reads only columns that exist on Render (no storage_path), and
-- `bytes`, so run it before `clips-to-storage.mjs --finalize`.
SELECT 'libraries', count(*), md5(string_agg(library_key || updated_at || md5(data), ',' ORDER BY library_key)) FROM libraries
UNION ALL SELECT 'library_versions', count(*), md5(string_agg(id || library_key || md5(data), ',' ORDER BY id)) FROM library_versions
UNION ALL SELECT 'clips', count(*), md5(string_agg(hash || md5(bytes), ',' ORDER BY hash)) FROM clips;
SELECT 'clip bytes', coalesce(sum(octet_length(bytes)), 0) FROM clips;
SELECT 'library_versions_id_seq last_value', last_value FROM library_versions_id_seq;
SELECT 'library_versions max(id)', coalesce(max(id), 0) FROM library_versions;
