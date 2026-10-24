#!/usr/bin/env bash
# The data phase of the cutover, end to end, from a clean target: README.md
# "Order" steps 1–11 in one run. Rerunnable: every run starts by dropping the
# four app tables on Supabase and migrating again from Render, so a rehearsal
# and the real window run the same thing. Render is only read.
#
#   RENDER_EXTERNAL_URL=... SUPABASE_DB_URL=... SUPABASE_URL=... \
#   SUPABASE_SECRET_KEY=... SUPABASE_PUBLISHABLE_KEY=... \
#     migration/supabase/cutover.sh --workdir DIR [--user-email EMAIL --user-id ID] [--yes]
#
# --workdir      where the manifest, the dump and the log go (also TMPDIR).
# --user-email, --user-id
#                create their Supabase Auth user as their Render users.id (the run
#                prints the users table); the password is typed on the
#                terminal. Without them the run migrates everything, then
#                exits 3: data done, their account pending.
# --yes          skip the "drop the Supabase app tables?" prompt.
#
# TLS is added when the URLs carry no sslmode: Supabase verify-full against
# server/certs/supabase-prod-ca.crt, Render sslmode=require.
#
# Kept between runs: Storage objects (an object already there counts only if it
# matches the manifest) and Supabase Auth users (an existing one is reused).
#
# Before the real window: suspend the Render web service, so nothing writes to
# Render while this runs. The run checks that: Render's libraries and
# library_versions must read the same at the end as at the start, or it fails.
set -euo pipefail

workdir='' user_email='' user_id='' yes=0
while [ $# -gt 0 ]; do
  case "$1" in
    --workdir) workdir=${2:?--workdir needs a value}; shift 2 ;;
    --user-email) user_email=${2:?--user-email needs a value}; shift 2 ;;
    --user-id) user_id=${2:?--user-id needs a value}; shift 2 ;;
    --yes) yes=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$workdir" ] || { echo "--workdir is required" >&2; exit 2; }
{ [ -n "$user_email" ] && [ -n "$user_id" ]; } || { [ -z "$user_email" ] && [ -z "$user_id" ]; } || { echo "--user-email and --user-id go together" >&2; exit 2; }
for v in RENDER_EXTERNAL_URL SUPABASE_DB_URL SUPABASE_URL SUPABASE_SECRET_KEY SUPABASE_PUBLISHABLE_KEY; do
  [ -n "${!v:-}" ] || { echo "$v is unset" >&2; exit 2; }
done

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
mkdir -p "$workdir"
workdir=$(cd "$workdir" && pwd)
export TMPDIR=$workdir
with_param() { case "$1" in *\?*) echo "$1&$2" ;; *) echo "$1?$2" ;; esac; }
case "$SUPABASE_DB_URL" in *sslmode=*) ;; *) SUPABASE_DB_URL=$(with_param "$SUPABASE_DB_URL" "sslmode=verify-full&sslrootcert=$repo/server/certs/supabase-prod-ca.crt") ;; esac
case "$RENDER_EXTERNAL_URL" in *sslmode=*) ;; *) RENDER_EXTERNAL_URL=$(with_param "$RENDER_EXTERNAL_URL" "sslmode=require") ;; esac
export SUPABASE_DB_URL RENDER_EXTERNAL_URL
log=$workdir/cutover-$(date -u +%Y%m%dT%H%M%SZ).log
exec > >(tee -a "$log") 2>&1

src_q() { psql -X -At -v ON_ERROR_STOP=1 "$RENDER_EXTERNAL_URL" -c "$1"; }
dst_q() { psql -X -At -v ON_ERROR_STOP=1 "$SUPABASE_DB_URL" -c "$1"; }
dst_f() { psql -X -q -v ON_ERROR_STOP=1 "$SUPABASE_DB_URL" -f "$here/$1"; }
clips() { (cd "$workdir" && node "$repo/scripts/clips-to-storage.mjs" "$@"); }
step() { printf '\n== %s\n' "$*"; }
render_fingerprint() {
  src_q "SELECT (SELECT count(*) FROM libraries) || '/' || (SELECT coalesce(max(updated_at),0) FROM libraries) || '/' || (SELECT count(*) FROM library_versions) || '/' || (SELECT count(*) FROM clips)"
}

step "preflight"
for tool in psql pg_dump pg_restore node; do command -v "$tool" >/dev/null || { echo "missing $tool" >&2; exit 2; }; done
pg_major=$(pg_dump --version | sed -E 's/[^0-9]*([0-9]+).*/\1/')
[ "$pg_major" -ge 18 ] || { echo "pg_dump $pg_major: need 18 or newer" >&2; exit 2; }
bucket=$(curl -s -o /dev/null -w '%{http_code}' "$SUPABASE_URL/storage/v1/bucket/clips" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY")
[ "$bucket" = 200 ] || { echo "bucket clips: HTTP $bucket (README step 0 creates it)" >&2; exit 2; }
before=$(render_fingerprint)
echo "render fingerprint (libraries/max updated_at/versions/clips): $before"
echo "log: $log"

step "drop the Supabase app tables (Storage objects and Auth users are kept)"
if [ "$yes" != 1 ]; then
  read -r -p "Drop libraries, library_versions, clips, clip_jobs on $(dst_q 'SELECT current_database()') at Supabase? [y/N] " answer </dev/tty
  [ "$answer" = y ] || { echo "stopped, nothing changed"; exit 1; }
fi
dst_q 'DROP TABLE IF EXISTS clip_jobs, clips, library_versions, libraries CASCADE'

step "001 schema, then 004 RLS before any data"
dst_f 001_schema.sql
dst_f 004_rls.sql

step "002 data"
"$here/002_data.sh"

step "003 fixup"
dst_f 003_fixup.sql

step "005 verify: Render and Supabase must be identical"
psql -X -At -v ON_ERROR_STOP=1 "$RENDER_EXTERNAL_URL" -f "$here/005_verify.sql" > "$workdir/verify-render.txt"
psql -X -At -v ON_ERROR_STOP=1 "$SUPABASE_DB_URL" -f "$here/005_verify.sql" > "$workdir/verify-supabase.txt"
cat "$workdir/verify-render.txt"
diff "$workdir/verify-render.txt" "$workdir/verify-supabase.txt"
echo IDENTICAL

step "clips: manifest, copy, verify"
clips --manifest
clips
clips --verify-only

step "auth users"
node "$repo/scripts/auth-user-create.mjs" --map-from-render
user_pending=0
if [ -n "$user_email" ]; then
  [ "$(src_q "SELECT count(*) FROM users WHERE id = '$user_id'")" = 1 ] || { echo "--user-id $user_id is not a Render users.id" >&2; exit 1; }
  if [ "$(dst_q "SELECT count(*) FROM auth.users WHERE id::text = '$user_id'")" = 1 ]; then
    echo "their auth user $user_id already exists: kept"
  else
    echo "their Render users.id: $user_id. Type their new password, then Enter."
    node "$repo/scripts/auth-user-create.mjs" --email "$user_email" --id "$user_id" </dev/tty || true
  fi
fi
orphans=$(dst_q 'SELECT count(*) FROM libraries l LEFT JOIN auth.users u ON u.id::text = l.library_key WHERE u.id IS NULL')
echo "libraries with no auth user: $orphans"
[ "$orphans" = 0 ] || user_pending=1

step "finalize, verify, sweep"
clips --finalize
clips --verify-only
clips --sweep

step "RLS again, and the publishable key must be refused"
dst_f 004_rls.sql
for table in libraries library_versions clips clip_jobs; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$SUPABASE_URL/rest/v1/$table?select=*&limit=1" -H "apikey: $SUPABASE_PUBLISHABLE_KEY")
  case "$code" in 401|403|404) echo "REST $table: HTTP $code (refused)" ;; *) echo "REST $table: HTTP $code — readable with the publishable key" >&2; exit 1 ;; esac
done

step "Render unchanged during the run"
after=$(render_fingerprint)
[ "$after" = "$before" ] || { echo "Render changed during the run ($before -> $after): something wrote to it. Suspend the web service and rerun." >&2; exit 1; }
echo "render fingerprint unchanged: $after"

if [ "$user_pending" = 1 ]; then
  echo
  echo "DATA DONE, USER ACCOUNT PENDING: $orphans library without an auth user. Rerun with --user-email."
  exit 3
fi
echo
echo "CUTOVER DATA PHASE DONE. Next: Render env (docs/deploy.md), merge supabase-migration to main, resume the service, smoke."
