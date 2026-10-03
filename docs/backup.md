# Backups and restore (T054, re-scoped T065)

Her phrases are typed by hand and the server's Postgres database (Supabase)
is their system of record. Her phone holds a synced copy in IndexedDB
(`docs/sync.md`), which is the second copy but not a backup: a bad push
overwrites it, and iOS can evict it. Losing them is the one failure
this whole system exists to prevent. Read this document end to end before
you need it — it is written for the version of you who is stressed, it is
late, and something just went wrong.

## Decision D1: no managed backups

**2026-10-03, owner (Henning): Supabase Free tier accepted; no managed
backups; replaced by a daily backup.mjs timer on archbox plus the device copy;
restore-drill monthly.**

This reverses an earlier signed decision that paid managed Postgres backups
(Render `basic-256mb`) were the primary backup. Supabase Free has no project
backups at all; daily backups start at Pro. Do not assume the platform holds
a copy of her library. It does not.

## The arrangement, in one table

| | What it is | Who runs it | Where the copy lives |
|---|---|---|---|
| **`scripts/backup.mjs` on a daily timer** | **The primary backup.** `pg_dump` of the Supabase database through the session pooler, gzipped, 180-day retention. | systemd `--user` timer on archbox (`ops/archbox/`) | `BACKUP_DEST` on archbox |
| **The device copy** | Her phone holds her library in IndexedDB and syncs it; after a total server loss the next push restores it. | Her phone, continuously | Her iPhone |
| **`scripts/restore-drill.mjs`, monthly** | Proves a real backup restores. A backup nobody restored is a guess. | You, by hand, monthly | A scratch database on archbox |

Topology: the server runs on Render (`starter`); the database, Auth and
Storage are Supabase (Free). Session pooler, port 5432. **Enforce SSL** is on,
sign-ups are off, the Data API is off (RLS on every table anyway).

## What the dump holds, and what it does not

The dump is the `public` schema: `libraries` (her phrases, irreplaceable),
`library_versions` (the recoverable history), and `clips` (metadata rows).

- **Clip audio is not in the dump.** The bytes live in Supabase Storage. They
  are derived: every Clip is content-addressed audio ElevenLabs generates
  again from the same phrase, so losing them costs provider calls and
  waiting, never her work. That is why Storage is not backed up.
- **Users are not in the dump.** Supabase Auth owns them (`auth.users`).
  There is one user. Re-create her with the admin API if the project is
  lost (`scripts/auth-user-create.mjs`); her library is keyed by that user's id, so
  restoring a library into a new project needs the new id (rekey the row
  `library_key` and every `library_versions.library_key`).

## The project can pause

Supabase Free projects pause after about 7 days without activity, and a
project paused for more than 90 days cannot be restored from the dashboard.
She drills daily, but travel and illness happen.
`.github/workflows/keep-alive.yml` calls
`https://phrase-drill.onrender.com/api/status` every day; that route runs a
database query (the clip job queue counts), which Supabase should count as
activity. **Unverified:** whether Supabase counts a pooler query as activity;
confirm after cutover by watching the project stay active past day 7. If the
project does pause, un-pause it in the dashboard
(https://supabase.com/dashboard) within the 90 days.

Region: the Supabase project is in West US (Oregon) if offered, else North
California, next to the Render `oregon` service. The server makes several
database round trips per request.

## Environment (Render service): see docs/deploy.md

| Var | Value | Secret |
|---|---|---|
| `DATABASE_URL` | Supavisor **session** pooler URI, port 5432, **without** `sslmode=` (`server/db.js` pins the CA; a `sslmode` in the URL replaces it) | yes, `sync: false` |
| `SUPABASE_URL` | `https://<ref>.supabase.co` | no |
| `SUPABASE_SECRET_KEY` | `sb_secret_...` (Storage, token verification) | yes, `sync: false` |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` | public per-project values, build args for the PWA | no |
| `ELEVENLABS_API_KEY`, `ANTHROPIC_API_KEY` | unchanged | yes |

## The daily export (`scripts/backup.mjs`)

It produces a compressed logical dump on a machine you control.

`npm run backup`:

1. `pg_dump`s the `public` schema of the database named by `DATABASE_URL`
   (plain SQL, `--no-owner --no-privileges --schema=public`: the pooler role
   cannot read Supabase-owned schemas, and they are not her data).
2. Gzips the dump (Node's built-in `zlib`, streamed).
3. Writes it into the directory named by `BACKUP_DEST`, creating it if
   needed.
4. Deletes anything in that directory older than `BACKUP_RETENTION_DAYS`.

**Run it from a machine you own, never from the Render container.** That
filesystem evaporates on the next redeploy.

**`BACKUP_DEST` is a directory path, not a URI.** A `<scheme>://` value is
refused with an error.

### What is in the dump

The `public` schema, as in "What the dump holds" above. The dump has no
audio bytes: `clips` rows carry a `storage_path`, not the bytes.

Every step fails loudly: a non-zero exit and a `level: "error"` log line on
any failure — a wrong password, `pg_dump` missing, disk full. **It never
exits 0 having silently skipped a step.** An export that fails quietly is
worse than none, because it manufactures confidence nobody should have.

Nothing here ever logs `DATABASE_URL` or its password.
`scripts/pg-url.mjs` strips the password out of the connection string before
it ever becomes a child-process argument (visible to `ps`) or a log field;
`server/logger.js`'s existing redaction (the same primitive
`docs/server.md`'s "Provable: no key can leak" section documents for the
server itself) redacts the database password out of every field on every log
line this script writes, including error messages from a failed `pg_dump`.

### File naming

`phrase-drill-<ISO-8601 UTC>.sql.gz`, e.g.
`phrase-drill-2026-08-03T14-30-00Z.sql.gz` (colons swapped for dashes — safe
in a filename on every filesystem worth using). Lexicographic sort is
chronological sort by construction, so retention and "what's the latest
backup" are both mechanical string operations, never a parse of file
metadata that a copy or sync could disturb.

### Retention policy

**Default: 180 days.** Configurable via `BACKUP_RETENTION_DAYS`.

Reasoning: the failure this export exists for is a mistake that goes
unnoticed for a while — the task that motivated this doc names "five weeks"
as the illustrative case. A retention window has to comfortably outlast
"how long before anyone would plausibly notice and go looking," not just
match it. 180 days (~6 months) is long enough to cover a mistake noticed on
any reasonably foreseeable cadence, and the storage cost on a machine you
already own is a rounding error (this library is low tens of KB to low MB
per export per `docs/scale.md` §4). It is a flat window, not a tiered
grandfather-father-son scheme — one variable, easy to reason about under
stress.

**Retention only prunes what this script wrote.** It matches
`phrase-drill-<timestamp>.sql.gz` and touches nothing else in the
directory, so pointing `BACKUP_DEST` at a directory with other files in it
is safe.

### What must be installed

- `pg_dump` (export) and `psql` (restore drill), **version 18 or newer**: the
  client must be at least the server's major version
  (`pacman -S postgresql` on archbox). Check the server version in the
  Supabase dashboard.
- Node, to run the script.

Nothing else. There is no cloud-provider CLI to install.

### Environment variables

| Var | Required | Default | Meaning |
|---|---|---|---|
| `DATABASE_URL` | yes | — | The Supabase **session pooler** URI (`postgres://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require`). Here `sslmode=require` is right: `pg_dump` is libpq, not `pg`. The direct host `db.<ref>.supabase.co` is IPv6-only on Free. |
| `BACKUP_DEST` | yes | — | A local directory path, created if it does not exist. Not a URI — a `<scheme>://` value is refused. |
| `BACKUP_RETENTION_DAYS` | no | `180` | See "Retention policy" above. |

### Run an export by hand, right now

```sh
export DATABASE_URL='postgres://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require'
export BACKUP_DEST="$HOME/phrase-drill-backups"
npm run backup
```

Exit 0 and a final `"backup: done"` log line mean it worked. Anything else
means it did not; read the `error` field, it names the failing step.

## The daily timer on archbox

Units: `ops/archbox/phrase-drill-backup.service` and `.timer` (systemd
`--user`, daily, `Persistent=true` so a missed run happens at next boot).
Nothing here installs itself. On archbox:

1. Create `~/.config/phrase-drill/backup.env`, mode 600:
   ```sh
   DATABASE_URL=postgres://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require
   BACKUP_DEST=/home/<you>/phrase-drill-backups
   PHRASE_DRILL_DIR=/home/<you>/<path to the phrase-drill checkout>
   ```
   (`chmod 600 ~/.config/phrase-drill/backup.env`.)
2. Copy the units and enable the timer:
   ```sh
   mkdir -p ~/.config/systemd/user
   cp ops/archbox/phrase-drill-backup.service ops/archbox/phrase-drill-backup.timer ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemctl --user enable --now phrase-drill-backup.timer
   ```
3. Run it once now and read the log: `systemctl --user start phrase-drill-backup.service; journalctl --user -u phrase-drill-backup.service -e`.
   Check the file landed in `BACKUP_DEST`.
4. `systemctl --user list-timers phrase-drill-backup.timer` shows the next run.
   For the timer to fire while you are logged out, run
   `loginctl enable-linger $USER` once.
5. Edit the `ExecStart` node path in the service if node is not `/usr/bin/node`.

The monthly restore drill, against a local Postgres (never Supabase):
`DATABASE_URL=postgres://...@localhost:5432/postgres npm run restore-drill -- <latest backup>`.

Then put the `.sql.gz` somewhere that survives losing that machine too —
whatever you already do with files you care about.

## Restore, step by step

**There are two different restores here, for two different failures. Read
this section before picking one — the wrong choice in an emergency is
destructive, not just unhelpful.**

| | The failure it's for | What it does to the live database | Command |
|---|---|---|---|
| **Whole-database restore** | The database itself is gone or destroyed — a botched migration, a deleted or paused-and-expired Supabase project, corruption. | Replaces it entirely with the backup's contents. | "Whole-database restore" below |
| **Single-library recovery** | A mistake nobody noticed for a while — a deleted deck, a bad import — but the live database is otherwise fine and has real data added *since* the backup. | Touches **one row**; everything else in the live database is untouched. | "Recovering a single library" below |

For the whole-database case there is no platform recovery to try first (Free
has none): the export file is the way back.

**Restoring the whole database over a live one that has since gained new
data is the wrong tool and actively destroys work.** If she deleted a deck
five weeks ago and has typed new phrases into other decks since, a
whole-database restore brings the deleted deck back **and erases every
phrase added in those five weeks** — a worse outcome than the original
loss. That scenario is single-library recovery, not whole-database restore.
When genuinely unsure which applies: if the database still responds and
still has other current data in it, assume single-library recovery until
proven otherwise.

**Never restores over the live database — this is structural, not a
warning to be careful.** `scripts/restore-drill.mjs` generates its own
target database name at runtime
(`phrase_drill_restore_drill_<16 hex chars>`) and takes that name from
nowhere else — not an argument, not an environment variable, not the backup
file. There is no input through which this script can be pointed at the
production database. `DATABASE_URL` supplies only the server's
host/port/user/password; whatever database name is in it is read once (to
discard it) and never used. Both procedures below start the same way:
restore the backup into this disposable scratch database first.

### 0. Get the backup file, and rehearse the restore

1. **Get the backup file onto the machine running the drill.** `npm run backup`
   already writes a local `.sql.gz`.
2. **Run the drill** against a Postgres where you may `CREATE DATABASE` (a
   local one on archbox; the Supabase pooler cannot, and a drill must not
   touch production). Its database name is ignored:
   ```sh
   export DATABASE_URL='postgres://postgres:<password>@localhost:5432/postgres'
   npm run restore-drill -- ./phrase-drill-2026-08-03T14-30-00Z.sql.gz
   ```
   This creates a scratch database, restores the dump into it with `psql`,
   checks that `libraries`, `library_versions` and `clips` all exist, and (with no
   `--keep-scratch`, the default) drops the scratch database again — pass
   or fail. Read the `PASS`/`FAIL` lines it prints; a non-zero exit means at
   least one failed.
3. **To also prove a specific library round-trips byte-identical**, capture
   its hash *before* whatever incident prompted the restore (or from a
   known-good backup you still trust), then pass it in:
   ```sh
   # before the incident, or from a database still known to be good:
   psql "$DATABASE_URL" -t -A -c "SELECT data FROM libraries WHERE library_key = 'her-user-id'" \
     | sha256sum
   # after restoring:
   npm run restore-drill -- ./phrase-drill-....sql.gz \
     --library-key=her-user-id --expect-sha256=<hash from above>
   ```
   Without `--expect-sha256` the drill still fails on a missing table.
   Clip audio is not in the dump, so there is no clip check.

### Whole-database restore

Only when the database itself is gone or unusable — not for a deleted deck
with an otherwise-healthy database (see "Recovering a single library"
below). There is no platform recovery to try first: Free has none.

- Point `DATABASE_URL` at the real production database (the session pooler
  URI).
- Restore the backup file into it directly:
  ```sh
  gunzip -c phrase-drill-2026-08-03T14-30-00Z.sql.gz | \
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f -
  ```
  A plain `pg_dump` dump is idempotent-hostile against a non-empty database
  (it will hit "already exists" errors on `CREATE TABLE`) — run this against
  an **empty** database. If the production database still has data in it,
  either restore into a **new** database and repoint `DATABASE_URL` at it
  (update the env var on the `phrase-drill` service's Environment tab in
  Render, which redeploys automatically — `docs/deploy.md`), or drop and
  recreate the production database first if you are certain the backup is
  the source of truth going forward.
- Redeploy so the stores' `init()` calls run against the restored schema (Render redeploys automatically on an env var
  change; `docker compose up --build` locally) — both are idempotent
  (`CREATE TABLE IF NOT EXISTS`, `docs/server.md` "Schema: creation and
  change"), so this is safe to run again even against an already-restored
  database.

### Recovering a single library

The scenario this task exists for: a deck (or several) was deleted or
overwritten, it wasn't noticed for a while, and the live database otherwise
has real, wanted data — including phrases typed in since the backup was
taken. `libraries` has exactly one row per user, and the entire library —
every deck — lives in that one row's `data` column as a single JSON blob.
There is no way to restore "just the deleted deck": recovering it means
reading the *old* blob out of the backup and reconciling it with the
*current* one by hand.

1. **Restore to scratch, and keep it** — this is the only difference from
   the rehearsal above:
   ```sh
   npm run restore-drill -- ./phrase-drill-2026-08-03T14-30-00Z.sql.gz --keep-scratch
   ```
   On success this prints the scratch database's name and a ready-to-run
   `psql` connection command — copy it, the database is left running.
2. **Pull the old blob out of the scratch database:**
   ```sh
   PGPASSWORD='<same password as DATABASE_URL>' \
     psql '<the connection command restore-drill just printed>' \
     -t -A -c "SELECT data FROM libraries WHERE library_key = 'her-user-id'" \
     > old-library.json
   ```
3. **Pull the current blob out of the live database, for comparison —
   this is the copy that has her newest phrases and must not be lost:**
   ```sh
   psql "$DATABASE_URL" -t -A -c "SELECT data FROM libraries WHERE library_key = 'her-user-id'" \
     > current-library.json
   ```
4. **Inspect both and merge by hand.** `old-library.json` has the deleted
   deck; `current-library.json` has everything added since. **There is no
   tooling here that merges these for you, deliberately** — at this scale
   (one person's decks, low tens of KB, `docs/scale.md` §4) a JSON diff read
   by eye and a hand-edited merged file is faster and safer than trusting an
   automated three-way merge to guess correctly which side wins on a
   changed deck. Open both files, copy the missing deck(s) from
   `old-library.json` into `current-library.json`, save the result as
   `merged-library.json`. **If a blind overwrite of the live row with
   `old-library.json` is tempting because this feels urgent — don't.** That
   discards every phrase added since the backup, which is the exact
   destructive outcome this two-path split exists to prevent.
5. **Write the merged blob back into the live database** — one `UPDATE`,
   nothing else touched:
   ```sh
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c \
     "UPDATE libraries SET data = \$mrg\$$(cat merged-library.json)\$mrg\$, updated_at = $(date +%s%3N) WHERE library_key = 'her-user-id'"
   ```
   (`$mrg$...$mrg$` is a Postgres dollar-quoted string, so the JSON's own
   quotes need no manual escaping.)
6. **Verify in the app itself** — log in, confirm the recovered deck is back
   *and* the newer decks/phrases are still there, before telling her it's
   fixed.
7. **Drop the scratch database** once you're done reading from it — it does
   not clean itself up when `--keep-scratch` was used:
   ```sh
   psql "$(echo "$DATABASE_URL" | sed 's|/[^/]*$|/postgres|')" \
     -c 'DROP DATABASE "<scratch database name>" WITH (FORCE)'
   ```
   (or use the exact command `restore-drill.mjs` already printed in step 1
   — it's the same one).

## Scheduling

Daily, by the archbox timer ("The daily timer on archbox"). A backup that
stops running is silent, so once a month, when you run the restore drill,
also look at the newest file in `BACKUP_DEST`: it must be under two days old.

## Verified proof this works (T054, re-confirmed T065)

**Historical.** This section was written against the Render-era schema
(`users`, `sessions`, `bytea` clips) and a seeded local Postgres. The
method still holds; the table list and the clip-digest checks no longer
exist. Re-run it against the Supabase pooler after cutover.

Every claim below is a command that was run, against a real Postgres, with
its real output. "The script exits 0" is not on this list — the whole point
of a drill is that exit 0 proves nothing on its own.

### Environment

A throwaway `postgres:17-alpine` Docker container (`t054-drill-pg`, port
55433, throwaway local-only credentials), never the repo's own
`phrase-drill-postgres-1` and never `docker-compose.yml`. Client tools:
`pg_dump`/`psql` 18.4. Schema created by the server's own
`createLibraryStore(pool).init()` and
`createClipStore(pool).init()` — the same calls a boot makes, not hand-written
DDL. Container removed afterward.

### What was seeded

One user, one session, one library of three decks (`Verbes irréguliers`,
`Salutations`, `Au marché`) with eight French/English phrases including
accented and typographic characters, and **three `clips` rows with real
`bytea` content** chosen to break a text path if one existed: a NUL byte, a
`0xFF`, a backslash, CR and LF, a quote, and three invalid UTF-8 sequences
(`c3 28`, an unpaired surrogate `ed a0 80`, an out-of-range `f4 90 80 80`),
followed by a 4 KB pseudo-audio body — plus a 1-byte clip that is a single
NUL, the smallest thing a length check would wave through.

### The round-trip

```
$ npm run backup            # BACKUP_DEST=<local dir>
{"level":"info",...,"msg":"backup: starting","filename":"phrase-drill-2026-08-04T03-33-26Z.sql.gz","destinationKind":"local"}
{"level":"info",...,"msg":"backup: dump complete","bytes":2150}
{"level":"info",...,"msg":"backup: uploaded","destination":".../phrase-drill-2026-08-04T03-33-26Z.sql.gz"}
{"level":"info",...,"msg":"backup: done","filename":"phrase-drill-2026-08-04T03-33-26Z.sql.gz","prunedCount":0}
EXIT=0

$ npm run restore-drill -- ./phrase-drill-2026-08-04T03-33-26Z.sql.gz \
    --library-key=usr_drill_marguerite --expect-sha256=a0629e0e... \
    --expect-clips-sha256=5ce72f79...
PASS — table "users" exists
PASS — table "sessions" exists
PASS — table "libraries" exists
PASS — table "clips" exists
PASS — clip audio round-trips as binary (bytea, not text) (3 clip(s))
PASS — clip store is byte-identical to the pre-backup clip digest (5ce72f7918e4873dfd8007a42e9e3df61d953b3009b13ed96304da81a3dc37f9 over 3 clip(s))
PASS — library "usr_drill_marguerite" round-trips
PASS — restored data is byte-identical to the pre-backup hash (a0629e0eeaf142ae057482eccfd91ca2b62353add1281702023f11fcfe625072)
EXIT=0
```

### Re-run after the s3 removal (T065)

The `destinationKind` and `"backup: uploaded"` fields above are the T054
wording; T065 renamed them to `destDir` and `"backup: written"` when the s3
branch was deleted — there is no longer a kind to distinguish or an upload
to name. Re-run afterward against the repo's own `docker-compose.yml`
Postgres (`postgres:17-alpine`, schema created by the same three `init()`
calls, no rows seeded — this run proves the path still works end to end,
not the round-trip fidelity T054 already proved):

```
$ export DATABASE_URL='postgres://phrase_drill:phrase_drill@<compose-postgres-ip>:5432/phrase_drill'
$ export BACKUP_DEST=<local dir>
$ npm run backup
{"level":"info","ts":"2026-08-04T03:55:24.851Z","msg":"backup: starting","filename":"phrase-drill-2026-08-04T03-55-24Z.sql.gz","destDir":"<local dir>"}
{"level":"info","ts":"2026-08-04T03:55:24.883Z","msg":"backup: dump complete","bytes":855}
{"level":"info","ts":"2026-08-04T03:55:24.884Z","msg":"backup: written","destination":"<local dir>/phrase-drill-2026-08-04T03-55-24Z.sql.gz"}
{"level":"info","ts":"2026-08-04T03:55:24.884Z","msg":"backup: done","filename":"phrase-drill-2026-08-04T03-55-24Z.sql.gz","prunedCount":0}
EXIT=0

$ npm run restore-drill -- <local dir>/phrase-drill-2026-08-04T03-55-24Z.sql.gz
PASS — table "users" exists
PASS — table "sessions" exists
PASS — table "libraries" exists
PASS — table "clips" exists
PASS — clip audio round-trips as binary (bytea, not text) (0 clip(s))
PASS — clip digest (no --expect-clips-sha256 given to compare against) (e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 over 0 clip(s))
EXIT=0

$ BACKUP_DEST='s3://phrase-drill-backups' npm run backup
backup: failed — BACKUP_DEST must be a local directory path, not "s3://..." — this script writes to a directory on the machine that runs it (docs/backup.md)
EXIT=1
```

The third command is the negative control for the removal: a leftover
`s3://` value fails loudly and says why, rather than creating `./s3:/…`
and reporting a successful backup.

### How the bytea was actually verified

Not by the drill's own verdict — by an independent check that does not share
code with it. The backup was restored a second time with `--keep-scratch`,
and every row of all four tables was read out of both the live database and
the restored scratch database through the `pg` driver, digesting each clip's
`bytes` **as the Buffer the driver returns** (with its length, leading 24
bytes and trailing 8 bytes recorded alongside). The two dumps were compared
with `diff`: **identical, byte for byte, every row.** The adversarial clip
came back as `00ff5c0a0d27221a0000c328eda080f49080807ffffb9064…`, exactly the
bytes that went in — including the NUL, the invalid UTF-8, and the lone
`0x00` one-byte clip.

Conclusion, stated plainly: **`pg_dump` plain-SQL format round-trips this
schema's `bytea` correctly.** The gap was never the dump. It was the drill,
which did not look.

### The negative controls (a check that cannot fail proves nothing)

1. **Wrong clip digest** — `--expect-clips-sha256=0000…` →
   `FAIL — clip store is byte-identical to the pre-backup clip digest`,
   exit 1.
2. **A dump with no `clips` table**, taken with `--exclude-table=clips` —
   what a backup made before T063, or one that silently skipped the table,
   looks like → `FAIL — table "clips" exists`, exit 1. **Before the clips
   checks were added, this same dump printed three `PASS` lines and exited
   0**: a backup that had lost every clip, reported as healthy. That is the
   defect this section exists to record as fixed.
3. **Wrong library hash** (from the earlier T054 run) → `FAIL` on that one
   check and exit 1, scratch database dropped either way.

### The scratch database

Confirmed dropped after every run:
`SELECT datname FROM pg_database WHERE datname LIKE 'phrase_drill_restore_drill_%'`
returned nothing, including after the `--keep-scratch` run was cleaned up
with the exact `DROP DATABASE … WITH (FORCE)` command the script itself
printed.

### What this drill still does not prove

- **No production data was involved.** This was a seeded throwaway database,
  not her library and not Render's Postgres. It proves the scripts are
  correct; it does not prove any particular real backup file is good. Only
  running the drill against a real backup does that.
- **Nothing has been run against Supabase.** Neither this script against the
  pooler URL, nor the archbox timer. Do both after cutover.
- **Retention was never exercised against a real expiry.** `prunedCount: 0`
  — no file in the destination was older than 180 days. `selectExpiredBackups`
  is unit-tested; the live prune is not proven here.
- **The single-library recovery path** (`--keep-scratch`, hand-merge,
  `UPDATE`) was walked in the earlier T054 run and its `--keep-scratch`
  behaviour re-confirmed here, but the hand-merge step is by design manual
  and has no automated proof.
</content>
