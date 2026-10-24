#!/usr/bin/env bash
# Moves the data (not the schema) of libraries, library_versions and clips from
# Render into Supabase. Needs pg_dump/psql/pg_restore 18 (see README.md for the
# laptop container path).
#
#   RENDER_EXTERNAL_URL=... SUPABASE_DB_URL=... ./002_data.sh [--force-into-nonempty]
#
# Run 001_schema.sql first. Refuses to run into a target whose `libraries`
# already has rows, because a second restore would duplicate every row or fail
# half-way; --force-into-nonempty overrides that.
set -euo pipefail

: "${RENDER_EXTERNAL_URL:?RENDER_EXTERNAL_URL is unset}"
: "${SUPABASE_DB_URL:?SUPABASE_DB_URL is unset}"

force=0
for arg in "$@"; do
  case "$arg" in
    --force-into-nonempty) force=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

known='libraries library_versions clips clip_jobs users sessions'

echo "== source tables (\\dt)" >&2
psql -X "$RENDER_EXTERNAL_URL" -c '\dt' >&2

echo "== tables not in the plan (reported, NOT migrated)" >&2
unexpected=0
while IFS= read -r table; do
  [ -z "$table" ] && continue
  case " $known " in
    *" $table "*) ;;
    *) echo "UNEXPECTED TABLE: $table" >&2; unexpected=$((unexpected + 1)) ;;
  esac
done < <(psql -X -At "$RENDER_EXTERNAL_URL" -c "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1")
echo "$unexpected unexpected tables" >&2

existing=$(psql -X -At "$SUPABASE_DB_URL" -c 'SELECT count(*) FROM libraries')
if [ "$existing" != "0" ] && [ "$force" != "1" ]; then
  echo "refusing: target libraries already has $existing rows. Rerun with --force-into-nonempty only if you mean it." >&2
  exit 1
fi

dump=$(mktemp -t pd-data.XXXXXX.dump)
trap 'rm -f "$dump"' EXIT

pg_dump "$RENDER_EXTERNAL_URL" --data-only --no-owner --no-privileges \
  -t libraries -t library_versions -t clips -t library_versions_id_seq -Fc -f "$dump"
pg_restore --data-only --no-owner --no-privileges --exit-on-error -d "$SUPABASE_DB_URL" "$dump"
echo "== restored. Next: 003_fixup.sql, then 005_verify.sql on both sides." >&2
