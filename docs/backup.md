# Backups and restore (T054)

Her phrases exist in exactly one Postgres database. They were typed by hand
and exist nowhere else — not on her phone (the IndexedDB clip cache holds
generated audio, not the phrases themselves as a system of record; `PUT
/api/library` on the server is the only durable copy), not in a document,
not anywhere she could re-type them from. Losing them is the one failure
this whole system exists to prevent. Read this document end to end before
you need it — it is written for the version of you who is stressed, it is
late, and something just went wrong.

## The failure this covers, and the one it does not

Render's paid Postgres includes point-in-time recovery (PITR): a 3-day
window on a Hobby workspace, 7 days on Pro. PITR is real protection, but it
answers one question only — **"the database broke at a known moment, put it
back the way it was just before."** It does not answer the other question
that actually matters here: **"she deleted a deck five weeks ago and only
just noticed."** PITR's window has already closed on that mistake long
before anyone knew to look. A slow, quiet, human mistake — not a crash — is
the likely failure mode for one non-technical user typing phrases by hand,
and it is exactly the shape PITR is worst at.

That is why this exists: a **logical backup** (`pg_dump`), **compressed**,
shipped **off Render entirely**, with **retention measured in months, not
days**. Two independent safety nets, covering two different failures:

| | Covers | Window | Where it lives |
|---|---|---|---|
| Render PITR | A broken database at a known moment (bad migration, corrupted write, "put it back to 2pm today") | 3 days (Hobby) / 7 days (Pro) | Inside Render — the same outage or account problem that could take the primary database could plausibly take this too |
| This backup | A mistake nobody noticed immediately (a deleted deck, a bad import, a Phrase overwritten weeks ago) | `BACKUP_RETENTION_DAYS`, default 180 | An S3-compatible bucket, off Render |

Use PITR first if the timing fits (Render's dashboard, Recovery page — see
[Render's own docs](https://render.com/docs/postgresql-backups)). Reach for
this backup when the mistake is older than PITR's window, or when Render
itself is the thing that's unavailable.

## What is backed up, and how

`scripts/backup.mjs`:

1. `pg_dump`s the database named by `DATABASE_URL` (plain SQL, `--no-owner
   --no-privileges` — a database name or owner role is deployment detail,
   not part of her data).
2. Gzips the dump (Node's built-in `zlib`, streamed — no whole dump ever
   sits uncompressed on disk).
3. Uploads it to `BACKUP_DEST`, off Render (see "Destination" below).
4. Deletes anything at the destination older than `BACKUP_RETENTION_DAYS`.

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
any failure — a wrong password, `pg_dump` missing, the upload rejected, disk
full. **It never exits 0 having silently skipped a step.** A backup job that
fails quietly is worse than no backup job, because it manufactures
confidence nobody should have.

Nothing here ever logs `DATABASE_URL`, its password, or the S3 credentials.
`scripts/pg-url.mjs` strips the password out of the connection string before
it ever becomes a child-process argument (visible to `ps`) or a log field;
`server/logger.js`'s existing redaction (the same primitive
`docs/server.md`'s "Provable: no key can leak" section documents for the
server itself) redacts the database password and the S3 secret key out of
every field on every log line this script writes, including error messages
from a failed `pg_dump`/`aws` call.

### File naming

`phrase-drill-<ISO-8601 UTC>.sql.gz`, e.g.
`phrase-drill-2026-08-03T14-30-00Z.sql.gz` (colons swapped for dashes — safe
in a filename and an S3 key). Lexicographic sort is chronological sort by
construction, so retention and "what's the latest backup" are both
mechanical string operations, never a parse of file metadata that a copy or
sync could disturb.

### Retention policy

**Default: 180 days.** Configurable via `BACKUP_RETENTION_DAYS`.

Reasoning: the failure this backup exists for is a mistake that goes
unnoticed for a while — the task that motivated this doc names "five weeks"
as the illustrative case. A retention window has to comfortably outlast
"how long before anyone would plausibly notice and go looking," not just
match it — a survey conducted weeks later, a seasonal review, a "wait, where
did that deck go" months on. 180 days (~6 months) is long enough to cover a
mistake noticed on any reasonably foreseeable cadence, short enough that
storage cost stays negligible (this library is low tens of KB to low MB per
export per `docs/scale.md` §4 — a year of daily gzipped dumps at that size
is still a rounding error against a free storage tier). It is a flat window,
not a tiered grandfather-father-son scheme — one variable, easy to reason
about under stress, and the data volume here does not justify the added
complexity of a tiered policy.

**What retention does NOT cover:** a mistake noticed more than
`BACKUP_RETENTION_DAYS` after it happened has no backup left that predates
it. Raise `BACKUP_RETENTION_DAYS` if that risk matters more than the
(still-small) storage cost — it is a single env var, not a code or schema
change.

## Destination: what was chosen, and what was rejected

**Chosen: an S3-compatible bucket** (`BACKUP_DEST=s3://bucket[/prefix]`),
uploaded with the `aws` CLI (already installed in this environment;
otherwise a single well-known, widely-packaged binary — see "What must be
installed" below). No new npm dependency: shelling out to an existing,
boring, long-maintained tool instead of adding an SDK to `package.json`, per
this workflow's "prefer an established library, don't hand-roll it"
doctrine — and per the same doctrine, *not* hand-rolling AWS SigV4 request
signing in this script, which a maintained CLI already does correctly.

**Recommended provider: Backblaze B2.** S3-compatible (this script needs no
B2-specific code — set `BACKUP_S3_ENDPOINT` to B2's endpoint URL and
`BACKUP_S3_REGION` to its region, and everything else is identical to plain
S3), 10 GB storage free permanently (not a 12-month trial), and — the reason
it is the recommendation here rather than Cloudflare R2 — **its free tier
requires no payment method on file.** Verified directly against Backblaze's
own sign-up flow and account documentation (not a third party's summary):
account creation asks for an email and password only, no card, and the
account dashboard states the free-tier allowance (10 GB storage, 1 GB/day
free egress) with no card-on-file requirement anywhere in that flow. This
owner has already refused to add a card to a cloud provider once for exactly
this reason (Cloudflare R2 was the earlier candidate, rejected below) — a
destination that reintroduces that requirement reintroduces the blocker
already paid to remove. B2's S3-compatible endpoint needs an explicit region
alongside the endpoint URL (`BACKUP_S3_REGION`, forwarded as `--region`),
unlike plain AWS S3, which infers it — the one real difference this script
had to account for.

**Rejected:**
- **Cloudflare R2.** S3-compatible with zero egress fees, and a real
  candidate on paper — but Cloudflare requires a payment method on file to
  create *any* R2 bucket, including one that stays entirely within the free
  10 GB tier. This was the first destination chosen for this task and was
  corrected: the owner explicitly declined to put a card on file anywhere
  for a personal phrase-drill tool, and R2 does not offer a path around
  that. Keep it rejected for this reason specifically — the zero-egress
  property is real and worth remembering if the card requirement is ever
  acceptable, but it is not acceptable here.
- **Hand-rolled S3 signing over plain HTTPS** (no CLI at all) — avoids
  installing anything, but re-implements AWS SigV4 request signing by hand
  for one script. That is exactly the kind of code this workflow's own
  doctrine says not to write yourself when a boring, maintained tool
  already does it correctly; the failure mode of a subtly-wrong signature
  implementation is a backup job that silently uploads nothing useful.
- **`rclone`** — a fine tool (single static binary, broad backend support),
  but not already present anywhere in this stack, and `aws` already covers
  every S3-compatible destination worth using here via `--endpoint-url`.
  Adding a second CLI to install and document when one already suffices is
  needless operational surface.
- **Backblaze B2's own `b2` CLI** — B2 also exposes the S3-compatible API
  used above, so its first-party CLI (a Python package, pulling in a
  runtime this stack does not otherwise need) buys nothing the `aws` CLI
  doesn't already have.
- **A second Render disk/volume.** Not off-platform — a Render outage or
  account-level problem could plausibly take both copies at once, which
  defeats the entire point of a second copy.
- **Committing dumps to a git repo.** No retention mechanism beyond "every
  commit forever," bloats the repo permanently, and using version control as
  a backup store is a misuse of the tool regardless of secrecy.
- **Emailing a dump to the owner.** Not mechanically scriptable/reliable
  (attachment size limits, no programmatic retention), and turns "did the
  backup run" into "did I notice the email."
- **A plain local/other-machine destination** (e.g. `scp` to a home NAS or a
  second personal machine, no S3 layer at all) — genuinely considered, and
  would be the right call if this owner ever declines B2 too: for one
  person's low-MB phrase library, "off Render" doesn't require an
  S3-compatible bucket specifically, only that the copy lives somewhere a
  single Render account problem can't reach. Not chosen only because B2's
  free tier clears the bar (no card, real off-platform, `aws` CLI already
  covers it) with less new operational surface than standing up and
  maintaining reachability to a second machine.

### What must be installed

- `pg_dump` (backup) and `psql` (restore drill) — same major version family
  as the server's Postgres (17, per `docker-compose.yml`); both ship in the
  `postgresql-client` package on Debian/Ubuntu, `postgresql17` (or similar)
  on Alpine/RHEL.
- `aws` (the AWS CLI v2) — for the upload/prune step only; not needed for
  the restore drill unless the backup file must first be downloaded from
  the bucket (`aws s3 cp s3://... ./`). Install per
  [AWS's own instructions](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html);
  it does not require an AWS account to install, only to run against a
  bucket (a B2 "S3 Compatible" application key — not a B2 master
  application key, and not the older native-B2-API key type — works the
  same way as AWS credentials: the key ID goes in `AWS_ACCESS_KEY_ID`, the
  application key itself in `AWS_SECRET_ACCESS_KEY`. Generate one from the
  B2 dashboard: App Keys → Add a New Application Key, scoped to the backup
  bucket).

## Environment variables

| Var | Required | Default | Meaning |
|---|---|---|---|
| `DATABASE_URL` | yes | — | Same variable the server itself reads. |
| `BACKUP_DEST` | yes | — | `s3://bucket[/prefix]` in production. A local directory path is also accepted — used for the restore drill and local testing only; production always uses `s3://`. |
| `BACKUP_S3_ENDPOINT` | only for a non-AWS S3-compatible bucket | unset (plain AWS S3) | e.g. `https://s3.us-west-002.backblazeb2.com` for Backblaze B2 (region embedded in the hostname; the exact subdomain is shown on the bucket's page in the B2 dashboard). |
| `BACKUP_S3_REGION` | only alongside `BACKUP_S3_ENDPOINT`, for a provider whose S3-compatible API needs it explicit | unset | e.g. `us-west-002` for Backblaze B2 — the same region that appears in its endpoint hostname. Plain AWS S3 infers this and never needs it set. |
| `BACKUP_RETENTION_DAYS` | no | `180` | See "Retention policy" above. |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | yes (for an `s3://` destination) | — | Read directly by the `aws` CLI; this script never touches them beyond registering the secret key for log redaction. |

## Run a backup by hand, right now

```sh
export DATABASE_URL='postgres://phrase_drill:<password>@<host>:5432/phrase_drill'
export BACKUP_DEST='s3://phrase-drill-backups'
export BACKUP_S3_ENDPOINT='https://s3.us-west-002.backblazeb2.com'   # omit both for plain AWS S3
export BACKUP_S3_REGION='us-west-002'
export AWS_ACCESS_KEY_ID='...'      # B2 "S3 Compatible" application key ID
export AWS_SECRET_ACCESS_KEY='...'  # the application key itself
npm run backup
```

Exit 0 and a final `"backup: done"` log line mean it worked. Anything else —
a non-zero exit, a `"level":"error"` line — means it did not; read the
`error` field, it names the failing step.

## Restore, step by step

**There are two different restores here, for two different failures. Read
this section before picking one — the wrong choice in an emergency is
destructive, not just unhelpful.**

| | The failure it's for | What it does to the live database | Command |
|---|---|---|---|
| **Whole-database restore** | The database itself is gone or destroyed — a botched migration, a deleted Render resource, corruption with no PITR window left. | Replaces it entirely with the backup's contents. | "Whole-database restore" below |
| **Single-library recovery** | A mistake nobody noticed for a while — a deleted deck, a bad import — but the live database is otherwise fine and has real data added *since* the backup. | Touches **one row**; everything else in the live database is untouched. | "Recovering a single library" below |

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

1. **Get the backup file onto the machine running the drill**, if it isn't
   already local:
   ```sh
   aws s3 cp s3://phrase-drill-backups/phrase-drill-2026-08-03T14-30-00Z.sql.gz . \
     --endpoint-url https://s3.us-west-002.backblazeb2.com --region us-west-002
   ```
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
below).

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

**Render Cron Jobs** is the natural fit if the owner accepts a small paid
line item: it bills per-minute compute, from $0.00016/min on the Starter
instance type (Render's published pricing as of 2026 — verify at
[render.com/pricing](https://render.com/pricing) before relying on this
number, it changes). A nightly job running `npm run backup` for a couple of
minutes costs a small fraction of a cent per run — call it under $0.10/month
even with margin for a slow run, not the flat $25/month "Pro workspace" fee
(that fee buys other things; Cron Jobs bill their own compute regardless of
workspace tier). Set up: new Cron Job resource in Render, point it at this
repo/branch, command `npm run backup`, schedule e.g. `0 3 * * *` (03:00
UTC daily), and set `DATABASE_URL` (the *internal* Render URL — the job runs
inside Render's network alongside the database), `BACKUP_DEST`,
`BACKUP_S3_ENDPOINT`, `BACKUP_S3_REGION`, `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY` in its environment variables.

**Free alternative: a scheduled GitHub Actions workflow.** GitHub Actions'
free tier (2,000 minutes/month on a private repo, unlimited on a public one)
comfortably covers one short job a day. The one thing this needs that Render
Cron Jobs gets for free by being inside Render's network: Render's
**external** database connection string (`docs/server.md` doesn't document
this because the app itself only ever uses the internal one) — copy it from
the database's page in the Render dashboard ("Connect" → "External Database
URL") and append `?sslmode=require` if it isn't already TLS. Example
workflow (`.github/workflows/backup.yml`, not created by this task — add it
if the owner picks this path):
```yaml
on:
  schedule:
    - cron: '0 3 * * *'
jobs:
  backup:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: sudo apt-get update && sudo apt-get install -y postgresql-client awscli
      - run: npm run backup
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}      # the *external* Render URL, ?sslmode=require
          BACKUP_DEST: ${{ secrets.BACKUP_DEST }}
          BACKUP_S3_ENDPOINT: ${{ secrets.BACKUP_S3_ENDPOINT }}
          BACKUP_S3_REGION: ${{ secrets.BACKUP_S3_REGION }}
          AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
```
GitHub's own secret store keeps every credential out of the workflow file
itself, the same "never committed" rule `docs/server.md` already holds the
provider keys to.

## Verified proof this works (T054)

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
$ npm run backup            # BACKUP_DEST=<local dir>, standing in for s3://
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
- **The `s3://` path was not exercised.** `BACKUP_DEST` pointed at a local
  directory. The upload is one `aws s3 cp` and the prune is `aws s3 ls`/`rm`,
  covered by unit tests over `awsArgs`, but no bucket was written to — that
  needs credentials this drill deliberately did not have. The first real run
  against Backblaze B2 is what settles it.
- **Retention was never exercised against a real expiry.** `prunedCount: 0`
  — no file in the destination was older than 180 days. `selectExpiredBackups`
  is unit-tested; the live prune is not proven here.
- **The single-library recovery path** (`--keep-scratch`, hand-merge,
  `UPDATE`) was walked in the earlier T054 run and its `--keep-scratch`
  behaviour re-confirmed here, but the hand-merge step is by design manual
  and has no automated proof.
