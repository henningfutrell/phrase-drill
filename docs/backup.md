# Backups and restore (T054, re-scoped T065)

Her phrases exist in exactly one Postgres database. They were typed by hand
and exist nowhere else — not on her phone (the IndexedDB clip cache holds
generated audio, not the phrases themselves as a system of record; `PUT
/api/library` on the server is the only durable copy), not in a document,
not anywhere she could re-type them from. Losing them is the one failure
this whole system exists to prevent. Read this document end to end before
you need it — it is written for the version of you who is stressed, it is
late, and something just went wrong.

## The arrangement, in one table

| | What it is | Who runs it | Where the copy lives |
|---|---|---|---|
| **Render managed Postgres backups** | **The primary mechanism.** Point-in-time recovery, plus downloadable logical exports, both provided by Render for every paid database. | Render, continuously, with no configuration in this repo | Inside Render |
| **`scripts/backup.mjs`** | The **secondary, manual, off-platform** copy. A human runs it and gets a `.sql.gz` file on a machine they own. | You, by hand, when you want one | Wherever you point `BACKUP_DEST` — a directory on your own machine |

**There is no scheduled off-site backup, and this repo does not pretend
there is one.** An earlier version of this document described an `s3://`
cron job to a Backblaze B2 bucket. The owner has no S3 account and no
Backblaze account and is not getting one, so that path was deleted in T065
rather than left standing as a plan nobody would execute. What replaced it
is not a downgrade — it is the decision `render.yaml` already made, written
down: pay for a managed database whose backups are somebody else's job.

## Primary: Render's managed Postgres backups

`render.yaml` pins `plan: basic-256mb` — the smallest **paid** Postgres tier
— and its own comment says why: Render's free Postgres "expires 30 days
after creation and carries no backups of any kind — unacceptable for the
one copy of her phrase library". That is not a cost decision that happens to
have a backup side effect. **Buying the backups is the point of the paid
tier**, and it is the primary backup mechanism for this application.

What that buys, from Render's own documentation (see "What is confirmed and
what is not" below before betting on a number):

- **Point-in-time recovery (PITR), automatically.** Render "continually
  backs up paid Render Postgres databases to provide point-in-time
  recovery". Nothing in this repo configures it; it is on because the plan
  is paid.
- **Retention: 3 days on a Hobby workspace, 7 days on Pro or higher.**
  Render states the window "depends on your workspace's plan", not on the
  instance type — so `basic-256mb` versus `pro-*` does **not** change the
  window. Upgrading the workspace later does not backfill it.
- **Logical exports, downloadable.** Render also produces logical backups
  for paid databases, retained "for seven days after creation, regardless of
  your workspace plan", and offers them on the database's Recovery page as a
  compressed archive (e.g. `2025-02-03T19_21Z.dir.tar.gz`) with a download
  link.
- Render's own stated preference between the two: "PITR almost always
  enables you to recover more recent data than what's available in your
  latest export."

### Restoring from Render — the exact path

**A Render restore creates a NEW database instance. It never restores in
place.** Render: "Render spins up a new database instance that reflects your
original instance's state at a specified time in the past." Plan for the
repoint, not just the restore.

1. Render dashboard → select the `phrase-drill-db` database → **Recovery**
   page.
2. Scroll to **Point-in-Time Recovery** → **Restore Database**.
3. Name the new instance.
4. Pick the date and time. **You cannot restore to a time within ten minutes
   of now.**
5. **Copy Existing Settings** — "No" lets you change instance type, Datadog
   API key, and/or project. Either way the new instance always copies the IP
   address allow list.
6. **Start Recovery** (or **Customize Recovery** if you declined step 5).
7. Watch the status: **Recovery In Progress** → **Creating** → **Available**.
8. Verify with the **PSQL Command** on the new instance's **Info** page
   before touching anything else.
9. **Repoint the app at the new instance.** `render.yaml` wires
   `DATABASE_URL` with `fromDatabase: {name: phrase-drill-db}`, which names
   the *old* resource — the recovery instance has a different name, so this
   is a manual change on the `phrase-drill` service's Environment tab
   (a change there redeploys automatically — `docs/deploy.md`). The
   redeploy re-runs the idempotent `init()` calls against the restored
   schema, which is safe.
10. Delete or suspend the original once the app is confirmed working against
    the new one. "Your recovery instance is now your primary instance."

If the timestamp was wrong: delete the recovery instance and start a new
recovery at a different point in time. Nothing was destroyed by getting it
wrong, which is the property that makes this path safe to attempt under
stress.

### What is confirmed and what is not

Every number above is quoted from Render's own documentation
([Recovery & Backups](https://render.com/docs/postgresql-backups),
[Flexible plans](https://render.com/docs/postgresql-refresh)) as of
2026-08. Two gaps, stated rather than papered over:

- **Which workspace plan this account is on has not been confirmed** — no
  live Render account was used to write this. That decides whether the PITR
  window is **3 days or 7**. Check it in the Render dashboard and write the
  answer here.
- **Whether Render's logical exports run on an automatic schedule is not
  established from Render's docs.** The documentation describes a manual
  **Create export** button and a seven-day retention, but names no cadence.
  Do not assume a nightly export exists until the Recovery page shows a
  series of them appearing without anyone pressing anything.
- Render's docs never state that `basic-256mb` specifically is a paid
  instance type; that follows from the blueprint spec listing `free` and
  `basic-256mb` as separate values and from Render gating features on
  "paid instance type". It is an inference, not a quote — a confident one,
  but worth knowing it is one.

### The failure Render's backups do NOT cover

PITR answers exactly one question: **"the database broke at a known moment,
put it back the way it was just before."** It does not answer the question
that is most likely to actually happen here: **"she deleted a deck five
weeks ago and only just noticed."** Three days — or seven, or Render's
seven-day export retention — has already closed on that mistake long before
anyone knows to look. A slow, quiet, human mistake is the likely failure
mode for one non-technical user typing phrases by hand, and it is exactly
the shape PITR is worst at.

**Nothing in this system currently covers that failure automatically.** The
manual export below covers it only as often as somebody remembers to run it.
That is the honest state of things, and it is the gap to close if this ever
gets more attention.

## Secondary: the manual export (`scripts/backup.mjs`)

A human runs it, on demand, and gets a compressed logical dump on a machine
they control. It is the answer to two questions Render cannot answer:
"give me a copy that survives losing the Render account entirely", and
"give me a copy older than Render's retention window".

`npm run backup`:

1. `pg_dump`s the database named by `DATABASE_URL` (plain SQL, `--no-owner
   --no-privileges` — a database name or owner role is deployment detail,
   not part of her data).
2. Gzips the dump (Node's built-in `zlib`, streamed — no whole dump ever
   sits uncompressed on disk).
3. Writes it into the directory named by `BACKUP_DEST`, creating it if
   needed.
4. Deletes anything in that directory older than `BACKUP_RETENTION_DAYS`.

**Run it from a machine you own, never from the Render container.** A
directory on Render's filesystem is not a backup: that filesystem is
ephemeral and evaporates on the next redeploy, and even if it did not,
a second copy inside the same account survives none of the failures the
first copy does not.

**`BACKUP_DEST` is a directory path, not a URI.** A `<scheme>://` value is
refused with an error rather than taken as a literal directory name — a
leftover `s3://phrase-drill-backups` would otherwise create `./s3:/…` and
report success.

### What is in the dump

Four tables, every one of them created by the server's own idempotent
`init()` calls (`server/db.js`): `users` and `sessions` (T050), `libraries`
(T043 — her phrases, the thing this exists for), and `clips` (T063 — the
shared Clip store, a `bytea` column holding the generated audio itself).
`pg_dump` takes all four; the restore drill checks all four.

**The two are not equally precious, and the drill says so out loud.**
`libraries` is irreplaceable — hand-typed, exists nowhere else. `clips` is
merely expensive: every row is content-addressed audio that ElevenLabs would
generate again from the same phrase, so losing it costs provider calls and
her waiting, not her work. Both are backed up anyway (the dump is a few KB
either way), but if you are ever choosing under pressure, `libraries` is the
one that cannot be rebuilt.

**`clips` is `bytea`, and binary columns are where a logical backup quietly
goes wrong** — a byte range mangled through a text path restores without an
error and plays as noise or nothing. That is why the drill's clip checks
compare the actual bytes rather than a row count (see "Restore, step by
step").

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

- `pg_dump` (export) and `psql` (restore drill) — same major version family
  as the server's Postgres (17, per `docker-compose.yml`); both ship in the
  `postgresql-client` package on Debian/Ubuntu, `postgresql17` (or similar)
  on Alpine/RHEL.

Nothing else. There is no CLI to install for a cloud provider, because there
is no cloud provider.

### Environment variables

| Var | Required | Default | Meaning |
|---|---|---|---|
| `DATABASE_URL` | yes | — | Same variable the server itself reads. For a pull off Render, this is the **External Database URL** from the database's page in the Render dashboard, with `?sslmode=require`. |
| `BACKUP_DEST` | yes | — | A local directory path, created if it does not exist. Not a URI — a `<scheme>://` value is refused. |
| `BACKUP_RETENTION_DAYS` | no | `180` | See "Retention policy" above. |

### Run an export by hand, right now

From your own machine, pulling the production database off Render:

```sh
export DATABASE_URL='postgres://phrase_drill:<password>@<external-host>.oregon-postgres.render.com/phrase_drill?sslmode=require'
export BACKUP_DEST="$HOME/phrase-drill-backups"
npm run backup
```

Exit 0 and a final `"backup: done"` log line mean it worked. Anything else —
a non-zero exit, a `"level":"error"` line — means it did not; read the
`error` field, it names the failing step.

Then put the resulting `.sql.gz` somewhere that survives losing that machine
too — whatever you already do with files you care about. This script's job
ends at writing the file.

## Restore, step by step

**There are two different restores here, for two different failures. Read
this section before picking one — the wrong choice in an emergency is
destructive, not just unhelpful.**

| | The failure it's for | What it does to the live database | Command |
|---|---|---|---|
| **Whole-database restore** | The database itself is gone or destroyed — a botched migration, a deleted Render resource, corruption with no PITR window left. | Replaces it entirely with the backup's contents. | "Whole-database restore" below |
| **Single-library recovery** | A mistake nobody noticed for a while — a deleted deck, a bad import — but the live database is otherwise fine and has real data added *since* the backup. | Touches **one row**; everything else in the live database is untouched. | "Recovering a single library" below |

For the whole-database case, **try Render's own PITR first** ("Restoring
from Render" above) — it recovers more recent data than any export, and it
does not destroy the original while you try it. Reach for the export file
when the mistake is older than Render's window, or when Render itself is
the thing that is unavailable.

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

1. **Get the backup file onto the machine running the drill.** If it came
   from `npm run backup` it is already a local `.sql.gz`. If it is one of
   Render's own logical exports, download it from the database's **Recovery**
   page in the dashboard — note that Render's export is a
   `.dir.tar.gz` directory-format archive restored with `pg_restore`, not
   the plain gzipped SQL this repo's drill expects.
2. **Run the drill** against the *same Postgres server* the production
   database lives on (its host/port/user/password — again, its database
   name is ignored):
   ```sh
   export DATABASE_URL='postgres://phrase_drill:<password>@<host>:5432/phrase_drill'
   npm run restore-drill -- ./phrase-drill-2026-08-03T14-30-00Z.sql.gz
   ```
   This creates a scratch database, restores the dump into it with `psql`,
   checks that `users`, `sessions`, `libraries` and `clips` all exist, checks
   that every restored clip's audio came back as *binary* rather than text,
   reports the clip store's digest and row count, and (with no
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
4. **To prove the audio round-trips byte-identical too**, capture the clip
   store's digest the same way — one statement, run against the live
   database *before* the backup, and run again by the drill against the
   scratch database afterward:
   ```sh
   # before: capture it (this is exactly CLIPS_DIGEST_SQL in restore-drill.mjs)
   psql "$DATABASE_URL" -t -A -c \
     "SELECT encode(sha256(coalesce(string_agg(hash || ':' || encode(bytes,'hex') || ':' || mime, E'\n' ORDER BY hash),'')::bytea),'hex') FROM clips"
   # after restoring:
   npm run restore-drill -- ./phrase-drill-....sql.gz \
     --expect-clips-sha256=<digest from above>
   ```
   Without `--expect-clips-sha256` the drill prints the digest and the clip
   count rather than comparing them — capture that number somewhere the next
   drill can reach it. Without `--expect-sha256`/`--expect-clips-sha256` the
   drill still fails on a missing table or on any clip that came back as
   text, which is the corruption a plain "it restored" would hide.

### Whole-database restore

Only when the database itself is gone or unusable — not for a deleted deck
with an otherwise-healthy database (see "Recovering a single library"
below), and not before checking whether Render's PITR window still covers
the incident.

- Point `DATABASE_URL` at the real production database.
- Restore the backup file into it directly:
  ```sh
  gunzip -c phrase-drill-2026-08-03T14-30-00Z.sql.gz | \
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f -
  ```
  A plain `pg_dump` dump is idempotent-hostile against a non-empty database
  (it will hit "already exists" errors on `CREATE TABLE`) — run this against
  an **empty** database. If the production database still has data in it,
  either restore into a **new** database and repoint `DATABASE_URL` at it
  (Render: update the env var on the `phrase-drill` service's Environment
  tab, which redeploys automatically — `docs/deploy.md`), or drop and
  recreate the production database first if you are certain the backup is
  the source of truth going forward.
- Redeploy so `createLibraryStore(pool).init()` / `createAuthStore(pool).init()`
  run against the restored schema (Render redeploys automatically on an env
  var change; `docker compose up --build` locally) — both are idempotent
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

**Nothing here is scheduled, and that is the current decision.** Render's
managed backups are continuous and need no cron; this script is deliberately
manual, run when a human wants an off-platform copy.

The cost of that is stated plainly under "The failure Render's backups do
NOT cover": a slow mistake noticed after Render's window has closed is only
covered if somebody happened to run an export recently. Closing that gap
means finding a machine that is reliably online to run `npm run backup` on a
timer against Render's **External Database URL**. That is a real piece of
operational surface — a machine to keep alive, a credential to rotate —
and it has not been taken on. Revisit it if the phrase library grows into
something whose loss would hurt more than it does today.

## Verified proof this works (T054, re-confirmed T065)

Every claim below is a command that was run, against a real Postgres, with
its real output. "The script exits 0" is not on this list — the whole point
of a drill is that exit 0 proves nothing on its own.

### Environment

A throwaway `postgres:17-alpine` Docker container (`t054-drill-pg`, port
55433, throwaway local-only credentials), never the repo's own
`phrase-drill-postgres-1` and never `docker-compose.yml`. Client tools:
`pg_dump`/`psql` 18.4. Schema created by the server's own
`createAuthStore(pool).init()`, `createLibraryStore(pool).init()` and
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
- **Nothing has been run against Render.** Neither this script against the
  External Database URL, nor a PITR restore, nor a logical export download.
  The Render half of this document is read off Render's documentation, not
  off a dashboard.
- **Retention was never exercised against a real expiry.** `prunedCount: 0`
  — no file in the destination was older than 180 days. `selectExpiredBackups`
  is unit-tested; the live prune is not proven here.
- **The single-library recovery path** (`--keep-scratch`, hand-merge,
  `UPDATE`) was walked in the earlier T054 run and its `--keep-scratch`
  behaviour re-confirmed here, but the hand-merge step is by design manual
  and has no automated proof.
</content>
