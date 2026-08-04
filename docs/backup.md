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

**Recommended provider: Cloudflare R2.** S3-compatible (this script needs no
R2-specific code — set `BACKUP_S3_ENDPOINT` to R2's endpoint URL and
everything else is identical to plain S3), 10 GB storage free permanently
(not a 12-month trial), and **zero egress fees** — the restore drill in this
doc means periodically pulling a backup back down, and R2 charging nothing
for that download is a real property, not a marketing line, unlike S3's
metered egress. A backup at this app's scale (low MB, `docs/scale.md` §4)
would need years of daily backups to approach the free tier's 10 GB.

**Rejected:**
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
- **Backblaze B2's own `b2` CLI** — B2 also has a real free tier (10 GB),
  but its first-party CLI is a Python package, pulling in a runtime this
  stack does not otherwise need. B2 also exposes an S3-compatible API, so
  if B2 is ever preferred over R2, this script needs no change — only
  `BACKUP_S3_ENDPOINT` and the bucket name.
- **A second Render disk/volume.** Not off-platform — a Render outage or
  account-level problem could plausibly take both copies at once, which
  defeats the entire point of a second copy.
- **Committing dumps to a git repo.** No retention mechanism beyond "every
  commit forever," bloats the repo permanently, and using version control as
  a backup store is a misuse of the tool regardless of secrecy.
- **Emailing a dump to the owner.** Not mechanically scriptable/reliable
  (attachment size limits, no programmatic retention), and turns "did the
  backup run" into "did I notice the email."

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
  bucket (an R2 API token/secret work the same way as AWS credentials —
  R2's own docs cover generating them).

## Environment variables

| Var | Required | Default | Meaning |
|---|---|---|---|
| `DATABASE_URL` | yes | — | Same variable the server itself reads. |
| `BACKUP_DEST` | yes | — | `s3://bucket[/prefix]` in production. A local directory path is also accepted — used for the restore drill and local testing only; production always uses `s3://`. |
| `BACKUP_S3_ENDPOINT` | only for a non-AWS S3-compatible bucket | unset (plain AWS S3) | e.g. `https://<account-id>.r2.cloudflarestorage.com` for Cloudflare R2. |
| `BACKUP_RETENTION_DAYS` | no | `180` | See "Retention policy" above. |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | yes (for an `s3://` destination) | — | Read directly by the `aws` CLI; this script never touches them beyond registering the secret key for log redaction. |

## Run a backup by hand, right now

```sh
export DATABASE_URL='postgres://phrase_drill:<password>@<host>:5432/phrase_drill'
export BACKUP_DEST='s3://phrase-drill-backups'
export BACKUP_S3_ENDPOINT='https://<account-id>.r2.cloudflarestorage.com'   # omit for plain AWS S3
export AWS_ACCESS_KEY_ID='...'
export AWS_SECRET_ACCESS_KEY='...'
npm run backup
```

Exit 0 and a final `"backup: done"` log line mean it worked. Anything else —
a non-zero exit, a `"level":"error"` line — means it did not; read the
`error` field, it names the failing step.

## Restore, step by step

**Never restores over the live database — this is structural, not a
warning to be careful.** `scripts/restore-drill.mjs` generates its own
target database name at runtime
(`phrase_drill_restore_drill_<16 hex chars>`) and takes that name from
nowhere else — not an argument, not an environment variable, not the backup
file. There is no input through which this script can be pointed at the
production database. `DATABASE_URL` supplies only the server's
host/port/user/password; whatever database name is in it is read once (to
discard it) and never used.

1. **Get the backup file onto the machine running the drill**, if it isn't
   already local:
   ```sh
   aws s3 cp s3://phrase-drill-backups/phrase-drill-2026-08-03T14-30-00Z.sql.gz . \
     --endpoint-url https://<account-id>.r2.cloudflarestorage.com
   ```
2. **Run the drill** against the *same Postgres server* the production
   database lives on (its host/port/user/password — again, its database
   name is ignored):
   ```sh
   export DATABASE_URL='postgres://phrase_drill:<password>@<host>:5432/phrase_drill'
   npm run restore-drill -- ./phrase-drill-2026-08-03T14-30-00Z.sql.gz
   ```
   This creates a scratch database, restores the dump into it with `psql`,
   checks that `users`, `sessions`, and `libraries` all exist, and drops the
   scratch database again — pass or fail. Read the `PASS`/`FAIL` lines it
   prints; a non-zero exit means at least one failed.
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
4. **If the drill passes and this is a real incident** (not a rehearsal),
   the scratch database it just proved good is already gone (step 2 drops
   it). To actually recover the live service:
   - Point `DATABASE_URL` at the real production database.
   - Restore the same backup file into it directly:
     ```sh
     gunzip -c phrase-drill-2026-08-03T14-30-00Z.sql.gz | \
       psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f -
     ```
     A plain `pg_dump` dump is idempotent-hostile against a non-empty
     database (it will hit "already exists" errors on `CREATE TABLE`) — run
     this against an **empty** database. If the production database still
     has data in it, either restore into a **new** database and repoint
     `DATABASE_URL` at it (Coolify: update the env var, redeploy), or drop
     and recreate the production database first if you are certain the
     backup is the source of truth going forward.
   - Redeploy (Coolify restarts the `phrase-drill` container automatically
     on a config change; `docker compose up --build` locally) so
     `createLibraryStore(pool).init()` / `createAuthStore(pool).init()` run
     against the restored schema — both are idempotent
     (`CREATE TABLE IF NOT EXISTS`, `docs/server.md` "Schema: creation and
     change"), so this is safe to run again even against an
     already-restored database.

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
`BACKUP_S3_ENDPOINT`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` in its
environment variables.

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
          AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
```
GitHub's own secret store keeps every credential out of the workflow file
itself, the same "never committed" rule `docs/server.md` already holds the
provider keys to.

## Verified proof this works (T054)

The restore drill was run for real against a throwaway `postgres:17-alpine`
Docker container (never the repo's own `phrase-drill-postgres-1`), seeded
with representative `users`/`sessions`/`libraries` rows, backed up with
`scripts/backup.mjs` to a local directory (standing in for an `s3://`
destination — the upload step is a single `aws s3 cp` call either way), and
restored with `scripts/restore-drill.mjs`. All five checks passed
(`users`/`sessions`/`libraries` tables present, the seeded library's row
present, its `data` column byte-identical by SHA-256 to the value captured
before the backup ran), exit 0. A second run with a deliberately wrong
expected hash produced `FAIL` on that one check and exit 1, and the scratch
database it created was confirmed gone afterward either way. See the T054
task record for the exact transcript.
