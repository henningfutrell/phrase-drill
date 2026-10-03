# Render to Supabase: one-off data migration kit

Moves her library and the Clip store from the Render Postgres into a Supabase
project, and creates her Supabase Auth user under her existing id. Run once, in
order, during the cutover window (after the app is frozen). Nothing here
touches Render except reads.

## Environment

| Variable | Used by | Value |
|---|---|---|
| `RENDER_EXTERNAL_URL` | `002_data.sh`, `--manifest`, `--map-from-render` | Render external connection string (read only) |
| `SUPABASE_DB_URL` | everything else | Supavisor **session pooler** string, `aws-0-<region>.pooler.supabase.com:5432` (the direct host is IPv6-only on Free) |
| `SUPABASE_URL` | `clips-to-storage`, `auth-user-create` | `https://<ref>.supabase.co` |
| `SUPABASE_SECRET_KEY` | same | the secret key, never the publishable one |

Client tools must be PG 18 or newer (`pg_dump`, `pg_restore`, `psql`). archbox has
them (`pacman -S postgresql`). On a laptop without them, run the SQL and the
shell script from a container:

```sh
pgc() { docker run --rm --network host -v "$PWD":/w -w /w -e RENDER_EXTERNAL_URL -e SUPABASE_DB_URL postgres:18 "$@"; }
pgc psql -X -v ON_ERROR_STOP=1 "$SUPABASE_DB_URL" -f migration/supabase/001_schema.sql
pgc migration/supabase/002_data.sh
```

Paths given to `pgc` must be relative to the repo root (it is mounted at `/w`).
The Node scripts run on the host. `postgres:18` is the Debian image; the alpine
one has no bash.

## Order

0. Create the Storage bucket `clips`: private, no policies, file size limit 1 MB, allowed MIME types = `SELECT DISTINCT mime FROM clips` on Render.
1. `psql -v ON_ERROR_STOP=1 "$SUPABASE_DB_URL" -f migration/supabase/001_schema.sql`. Expect five `CREATE` lines, no error.
2. `migration/supabase/002_data.sh`. Prints `\dt` of the source, then `UNEXPECTED TABLE: <name>` for anything outside users, sessions, libraries, library_versions, clips, clip_jobs (reported, not migrated). Refuses when `libraries` on the target already has rows; `--force-into-nonempty` overrides. Refuses when either variable is unset.
3. `psql -v ON_ERROR_STOP=1 "$SUPABASE_DB_URL" -f migration/supabase/003_fixup.sql`. Expect `UPDATE <n>` twice (n = clips with NULL `last_used_at`, then NULL `byte_size`; live predates `last_used_at`, so n = all clips for the first), then two `ALTER TABLE`.
4. `psql -X -At -f migration/supabase/005_verify.sql` on Render and on Supabase. **The two outputs must be identical** (`diff`). Expected: `clips` count 1004, `clip bytes` 34878568, `library_versions_id_seq last_value` at or above `max(id)` and equal on both sides.
5. `node scripts/auth-user-create.mjs --map-from-render` lists `id, username, created_at` of Render's `users`. Then, per user to keep: `node scripts/auth-user-create.mjs --email <email> --id <users.id>` and type the password on stdin (never argv, not echoed). Expect `created <email> as <id>` and `libraries with no auth user: 0`; any other count exits non-zero. If the API refuses `id`, the script still creates the user with a generated id and **prints** (does not run) a transaction that rewrites `library_key` in `libraries` and `library_versions`; run it by hand, then recheck.
6. `node scripts/clips-to-storage.mjs --manifest` (needs `RENDER_EXTERNAL_URL`). Writes `clips-manifest.tsv` in the current directory; expect `1004 clips, 34878568 bytes`. The manifest is the ground truth for the rest; keep it.
7. `node scripts/clips-to-storage.mjs --dry-run`, then `node scripts/clips-to-storage.mjs`. Prints a line per batch of 50; ends `copied 1004, already present 0, failed 0` (about 5 to 10 minutes). Safe to rerun after an interruption: rows with a `storage_path` are skipped, an existing object counts only if its download matches the manifest. Failed hashes are listed and the exit code is 1.
8. `node scripts/clips-to-storage.mjs --verify-only`. Expect `verify: PASS`: no row without `storage_path`, bucket holds 1004 objects, `sum(byte_size)` = 34878568, every object re-downloaded matches the manifest's length and sha256.
9. `node scripts/clips-to-storage.mjs --finalize` (`--dry-run` first prints the statements). Re-verifies in the same run and refuses on any failure; then `DROP COLUMN bytes`, `storage_path SET NOT NULL`, `VACUUM FULL clips`.
10. `psql -v ON_ERROR_STOP=1 "$SUPABASE_DB_URL" -f migration/supabase/004_rls.sql`. Locks the Data API: RLS on, no policies, grants revoked from `anon` and `authenticated`. Check: `curl "$SUPABASE_URL/rest/v1/libraries?select=*" -H "apikey: <publishable key>"` returns a permission error (`42501`), not rows. Also switch **Data API** off in Project Settings, API.
11. `node scripts/clips-to-storage.mjs --sweep` removes bucket objects no row names (`--dry-run` lists them). Expect `0 orphan objects removed` after a clean run.

`005_verify.sql` reads `bytes`, so it only runs before step 9. After it, `--verify-only` is the check.

## In one run: `cutover.sh`

`cutover.sh` runs steps 1–11 above in order, from a clean target, and stops at
the first failure. Every run first drops the four app tables on Supabase and
migrates again from Render; Storage objects and Auth users are kept (an object
counts only if it matches the new manifest; an existing auth user is reused).
So the rehearsal and the real window run the same command.

```sh
migration/supabase/cutover.sh --workdir <dir> --her-email <her email> --her-id <her Render users.id>
```

- Asks before dropping the tables (`--yes` skips the prompt), then asks for her
  new password on the terminal.
- Adds TLS to URLs that carry no `sslmode`: Supabase is verified against
  `server/certs/supabase-prod-ca.crt`, Render gets `sslmode=require`.
- Writes the manifest, the dump (`TMPDIR`), both `005_verify` outputs and a log
  into `<dir>`.
- Fails when Render's libraries/library_versions/clips change while it runs:
  suspend the Render web service first.
- Exit 0: done. Exit 3: data migrated, but a library has no auth user (run
  again with `--her-email`/`--her-id`). Anything else: failed; read the log.

Step 0 (the bucket) is not part of it; the run refuses if `clips` is missing.

## Rollback

Nothing on Render is changed or deleted by this kit; Render stays the source until
the Render database is deleted, which is the point of no return. Rollback is
therefore the Render side: roll the service back, restore its `DATABASE_URL`, copy
any library row edited after cutover back from Supabase. Clips made after cutover
are lost and regenerate. Keep a final `pg_dump` of Render on archbox before the
Render database is deleted. The full procedure is section 6 of the migration plan
(`phrase-drill-supabase-migration-plan.md`, kept with the owner's notes, not in
this repository).

To rerun this kit against a Supabase project from scratch: drop the four tables
and empty the `clips` bucket, then start at step 1. Do not use
`--force-into-nonempty` for that.

## Rehearsal

`scripts/clips-to-storage.rehearsal.test.js` runs the Clip move against a local
Supabase stack and scratch databases. It skips unless `REHEARSAL_DB_URL`,
`REHEARSAL_SUPABASE_URL` and `REHEARSAL_SUPABASE_SECRET_KEY` are set; the header
of the file has the command.
