# Deploying: Render server, Supabase database (T053)

For someone doing this once, with no memory of how `render.yaml` came to
look the way it does. Read `docs/server.md` first if you need the app's
endpoints, env vars, or its identity model — this document only covers
getting it running: the server on Render, the database, Auth and Storage
on Supabase.

Production runs on [Render](https://render.com), from `render.yaml` at the
repo root (a "Blueprint"). `docker-compose.yml` is **local dev only** —
Render does not read or run it. See `docs/server.md` for the local
`docker compose up` path.

**The service is `https://phrase-drill.onrender.com`.** Render's default
hostname from `render.yaml`'s `name: phrase-drill`. Measured 2026-08-24:
`curl -s https://phrase-drill.onrender.com/api/health` returns
`{"status":"ok"}`; `phrase-drill-app.onrender.com` and
`phrase-drill-web.onrender.com` both 404, so the name is unambiguous.

## Topology, and the backup decision (D1)

- **Render** runs the server (`phrase-drill`, `starter`, `oregon`) from
  `render.yaml`. It serves the PWA and the API.
- **Supabase** (Free tier) holds the database (Postgres), Auth and Storage
  (the Clip bytes). The server reaches Postgres through the **session
  pooler**, port 5432 (`aws-0-<region>.pooler.supabase.com`). **Enforce SSL**
  is on; the server verifies the certificate against
  `server/certs/supabase-prod-ca.crt`. Sign-ups are off and the Data API is
  off. Region: West US (Oregon) if offered, else North California, next to
  Render.
- The old Render Postgres (`databases:` in `render.yaml`) stays until 30 days
  after cutover as a rollback copy, then goes. **Removing it from a synced
  Blueprint may delete the database**: read the sync preview first and take a
  `backup.mjs` dump.

**2026-10-03, owner: Supabase Free tier accepted; no managed
backups; replaced by a daily backup.mjs timer on backup-host plus the device copy;
restore-drill monthly.** This replaces the earlier rule never to use a free
Postgres tier. The backup is yours to keep running: `docs/backup.md`.

**The Free project pauses after about 7 days without activity.**
`.github/workflows/keep-alive.yml` calls `/api/status` daily, which runs a
database query. A project paused over 90 days cannot be restored from the
dashboard. If the app says the database is unreachable, check
https://supabase.com/dashboard first.

### Environment variables on the Render service

| Var | Value | Secret |
|---|---|---|
| `DATABASE_URL` | Supavisor **session** pooler URI, port 5432, no `sslmode=` | yes, `sync: false` |
| `SUPABASE_URL` | `https://<ref>.supabase.co` | no |
| `SUPABASE_SECRET_KEY` | `sb_secret_...` | yes, `sync: false` |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` | public per-project values; build args (declared as `ARG` in the `Dockerfile`) | no |
| `ELEVENLABS_API_KEY`, `ANTHROPIC_API_KEY` | unchanged | yes, `sync: false` |

All `sync: false` vars are asked for at Blueprint creation and edited on the
service's Environment tab afterwards. A `VITE_*` change needs a rebuild
(redeploy), not a restart.

## One-time setup

1. **Connect the repo.** In the Render dashboard: New → Blueprint → pick
   this GitHub repo, this branch (`main`). Render reads `render.yaml` and
   shows you the plan: one web service (`phrase-drill`, `docker`, plan
   `starter`, `oregon`) and, until its decommission, the old Postgres
   database (`phrase-drill-db`).

2. **Set the secrets.** `render.yaml` declares the `sync: false` variables
   in the table above, which makes Render prompt for them during this same Blueprint-creation flow (a `sync: false` var is
   only prompted for at creation, not on every later sync — if you need to
   change one afterward, edit it directly on the service's Environment tab).
   Paste real values here; neither one is ever written to this repo.
   `DATABASE_URL` is the Supabase pooler URI, no longer wired from a Render
   database.

3. **Deploy.** Render builds the image from `Dockerfile` and starts it.
   `healthCheckPath: /api/health` is what Render polls to decide the
   deploy succeeded — watch the deploy log for a `200` from that path, or a
   failure it reports directly if the container never comes up.

4. **Create their account** in Supabase Auth (Dashboard → Authentication →
   Users → Add user, email + password, auto-confirm), with "Allow new users to
   sign up" off. There is no signup endpoint on this server. The server only
   verifies the access tokens Supabase issues (`docs/server.md`).

5. **Email: SMTP and the two code templates.** The user signs in with a code
   emailed to them, and resets a forgotten password the same way
   (`docs/server.md`, "Signing in"). Two settings on the Supabase project:
   - **Custom SMTP** — Dashboard → Project Settings → Authentication → SMTP
     Settings (https://supabase.com/dashboard/project/_/settings/auth). The
     built-in sender only delivers to members of the Supabase organization's
     team and only a few per hour, so without this their email never arrives.
     Then raise Authentication → Rate Limits → "emails sent per hour" from its
     default if it is lower than ~30.
   - **Templates** — Dashboard → Authentication → Emails
     (https://supabase.com/dashboard/project/_/auth/templates): set **Magic
     Link** to subject `Your phrase-drill sign-in code` and the body of
     `supabase/templates/magic-link.html`, and **Reset Password** to subject
     `Your phrase-drill code` and the body of `supabase/templates/recovery.html`.
     Both bodies carry `{{ .Token }}`; the defaults carry only a link, which
     the home-screen app cannot use.

## Verify it worked

- **Health:** `curl https://phrase-drill.onrender.com/api/health` returns
  `{"status":"ok"}`.
- **Login:** load the app in Safari on the phone, type their email, tap
  *Email me a code*, type the 6 digits from the email — it should land on the
  drill screen. An address with no account is refused, and none is created.
  Then the backup: *Use my password instead*; a wrong password is rejected,
  the right one lands on the drill screen.
- **Forgot password:** *Use my password instead* → *Forgot password?* → the
  emailed code → a new password typed twice → signed in. Log out and log in
  with the new password; Settings → *Change password* works the same way.
- **Library round-trip:** add a phrase (or import one via a scan), leave the
  page, come back, confirm it's still there — this exercises `PUT`/`GET
  /api/library` against the real managed Postgres, not just that the
  process is alive.
- **TLS to Postgres:** if login/library calls fail with a database error in
  the Render logs (Logs tab), check for `SELF_SIGNED_CERT_IN_CHAIN` or a
  generic SSL failure specifically — see "Postgres SSL" below.

## Shipping a change after the one-time setup

Everything above runs once. This is what happens every other time: a fix
lands on `main` and needs to reach their phone.

**A merge to `main` deploys it.** `.github/workflows/deploy.yml` runs the
gates, and only a green run calls Render's deploy hook. A red gate means **no
deploy** — the previous build stays live, which is the outcome you want: the user
keeps a working app rather than getting a broken one promptly.

| Gate | Command | Why it is in CI |
|---|---|---|
| Lint | `npm run lint` | |
| Typecheck | `npx tsc -b` | **never `tsc --noEmit`** — the root `tsconfig.json` is a solution file (`"files": []` + two references), so `--noEmit` compiles nothing and reports success |
| Test | `npm test` | 1391 tests. The real-Postgres tests self-skip with `SMOKE_DATABASE_URL` unset, so no database is wired into the job |
| Build | `npm run build` | |

Node in the job is pinned to **26**, because `Dockerfile` builds and runs on
`node:26-alpine`. CI green on a different major would prove nothing about the
image that actually ships. Install is `npm ci` (`package-lock.json` is
`lockfileVersion: 3`).

`npm run test:mutation` is deliberately **not** in CI — it is domain-scoped
and slow (`docs/testing.md`). It stays a local obligation when `src/domain/`
changes, per `AGENTS.md`.

Runs are at
<https://github.com/<owner>/phrase-drill/actions/workflows/deploy.yml>.

### The secret is `RENDER_WEBHOOK_URI`

A GitHub repository secret
(<https://github.com/<owner>/phrase-drill/settings/secrets/actions>)
holding the `phrase-drill` service's **Deploy Hook URL** from its Render
Settings page ([docs](https://render.com/docs/deploy-hooks)).

**The URL is itself a credential.** It carries a `key=` query parameter and
anyone holding it can trigger a deploy. Never commit it, and never write its
value into this file. The workflow passes it through an env var rather than
interpolating it into the command line, so it cannot land in a shell trace.

The `curl` is `curl -fsS`, and the `-f` is not stylistic: **without it curl
exits 0 on a 401**, so a regenerated or revoked hook would fail silently on
every deploy, forever. If the hook is ever regenerated on the Render Settings
page, update the secret — the workflow will go red until you do, which is the
intended behaviour.

**Never call the hook with a `ref=` parameter.** Per Render's docs, a
deploy-hook call naming a commit **disables automatic deploys for the
service** — which would silently undo the reconnect described below.

### Why a workflow and not Render's own auto-deploy

**Render cannot do it for this service, and the reason is structural.** The
service is linked to this repo by **public Git repository URL**, not through
a connected GitHub account — confirmed by the owner, 2026-08-24. Render's
docs are explicit: services using "a public Git repository URL ... must be
deployed manually"
([Deploys → Automatic deploys](https://render.com/docs/deploys#automatic-deploys)).
Auto-deploy is therefore **impossible by construction** for this service. No
dashboard setting turns it on, and no Blueprint sync binds it to
`render.yaml`. So this workflow is the release path, not a supplement to one.

**The earlier diagnosis in this document was wrong**, and is named here only
so it is not re-derived: it read the failure as an unreadable dashboard
default that one Blueprint → Sync would fix. It is not that. And the trap
that produced the reading is worth keeping: the dashboard's **Auto-Deploy
dropdown still displays "On Commit"** — the default for a new service — on a
service that can never act on it. It looked configured and working for three
weeks.

`render.yaml` declares `autoDeploy: true`. That declaration has **no effect
on a URL-linked service**; it is kept because it is correct the day the
service is reconnected through the GitHub account. It is also **deprecated**
in the current Blueprint spec in favour of `autoDeployTrigger: commit`
([Blueprint YAML reference](https://render.com/docs/blueprint-spec));
`autoDeploy: true` is still honoured, and `autoDeployTrigger` takes
precedence if both appear.

A plain GitHub **repo webhook** pointed straight at the deploy hook was also
rejected, and not on taste: `push` webhooks cannot filter by branch, and this
repo routinely pushes `wt/T###` and `backup/*` refs — every one of which would
have deployed `main`. The `if: github.ref == 'refs/heads/main'` on the deploy
step is what supplies the branch filter.

**What the absence of this cost.** Two round trips through a non-technical
user in another country — 2026-08-04 (the drill-unlock fix) and 2026-08-24
(the Route hold) — each to answer a question one `curl` answers in under a
second, once the service URL is known. See "How to tell what is actually
deployed" below.

### If the gates pass but nothing new is live

That is a finding about the **hook**, not about the gates. Check, in order:

1. The run's `Deploy` step — `curl -fsS` fails loudly on a 401/404, so a
   stale secret shows up there, not as silence.
2. Render dashboard → `phrase-drill` → **Events**, for a deploy that started
   and then failed, and **Logs** for the build or the health check
   (`healthCheckPath: /api/health`).
3. The sha check below. Do not re-run the workflow blindly.

The manual fallback, unchanged and still available: Render dashboard → the
`phrase-drill` service → **Events** → **Manual Deploy** → *Deploy latest
commit* ([docs](https://render.com/docs/deploys#manual-deploys)). Then
confirm with the sha check, not with the dashboard. Do **not** reach for
*Deploy a specific commit* unless you mean it: per Render's docs that option
**disables automatic deploys for the service**.

### The real fix, still needing the owner

**Reconnect the service through the GitHub account.** It makes the service
*eligible* for Render's own auto-deploy, at which point `render.yaml`'s
declaration starts meaning something and this workflow could drop its deploy
step (keeping its gates). **Warning: if Render requires the service to be
recreated in order to change its repo link, recreating it loses the
`fromDatabase` wiring for `DATABASE_URL` and both `sync: false` provider
keys** (`ELEVENLABS_API_KEY`, `ANTHROPIC_API_KEY` — they exist only in
Render's own store, never in this repo). So this is not obviously the safe
option: check whether the repo link is editable in place before touching it.

Until then, nothing needs doing. The workflow is the release path.

### On their phone, once a new build is live

`docs/pwa.md` covers what happens to their open tab (`autoUpdate` takes it over
without a reload — see "Update strategy" there); nothing further to do on the
phone side.

The in-app path to the same fact: Settings → Diagnostics, where the `Build:`
line shows the deployed commit's short sha and a build timestamp. `unknown`
there means either the build predates `e6c561d` (every deploy before that
commit stamped `unknown` — see `build-sha.ts`) or `RENDER_GIT_COMMIT` was not
injected. **Read the sha with `curl` first; this path costs a round trip
through them.**

## How to tell what is actually deployed

Two commands, from any machine, no dashboard and no phone:

```sh
A=$(curl -s https://phrase-drill.onrender.com/ | grep -o '/assets/index-[A-Za-z0-9._-]*\.js')
curl -s "https://phrase-drill.onrender.com$A" | grep -o -m1 '<expected-sha>'
```

The first prints the served bundle's hashed filename; the second prints the
short sha embedded in it (`build-sha.ts` stamps `RENDER_GIT_COMMIT` truncated
to 7 characters — never a local `git rev-parse`, on any Render build).
Compare against `/usr/bin/git rev-parse --short origin/main`. A grep for a
string only the new code contains is a second, independent check — e.g.
`Route hold` for `533e8ea`.

**The sha and the string are the signal. The bundle filename is not.** A
previous version of this document said a served filename differing from a
local `npm run build`'s filename was "by itself proof the deploy did not
land". That is **wrong**, and it produced a wrong prediction on 2026-08-24: a
local build of `533e8ea` produced `index-dNuddkml.js`, while Render's build
of the same commit serves `index-DY7Eh3oC.js`. The asset hash covers the
bundle bytes, and the two builds differ (different Node and platform,
`RENDER_GIT_COMMIT` present in one and absent in the other). **Never compare
filenames across a local and a Render build.**

**Measured 2026-08-24, in sequence, so neither half is over-read:**

| Time (UTC) | Observation |
|---|---|
| 19:30 | `origin/main` pushed `72063ff..533e8ea` |
| ~20:20, then polled 24 min | still `/assets/index-BE2GGMfB.js`, sha `72063ff`, no `Route hold` — **no auto-deploy** |
| after a Manual Deploy | `/assets/index-DY7Eh3oC.js`, sha **`533e8ea`**, `Route hold` **present** |

So the Route hold **is** on their phone, and the delivery mechanism is still
manual.

**Use this before asking them anything.** The Diagnostics path above reads the
same stamp, but it costs a round trip through a non-technical user in another
country. That cost was paid twice — 2026-08-04 and again 2026-08-24 — because
this check did not exist.

## Postgres SSL

`server/db.js#sslConfigFor` decides from `DATABASE_URL` alone:

- `*.pooler.supabase.com` and `*.supabase.co`: verify against the pinned
  Supabase root CA, `server/certs/supabase-prod-ca.crt` (hostname checked
  too). `server/certs/README.md` has its fingerprint and expiry (2031-04-26).
- `localhost`, loopback, and hostnames with no dot (the local
  `docker compose` case): no SSL.
- Any other remote host: the server refuses to start, naming the host. There
  is no "skip verification" fallback.

**Do not put `sslmode=` in the server's `DATABASE_URL`.** `pg` lets it
replace the pinned CA and the connection then fails certificate
verification. (`backup.mjs` is `pg_dump`, which does want `sslmode=require`.)

Before cutover, compare the CA file's SHA-256 fingerprint with the
certificate offered in the Supabase dashboard (Project Settings -> Database
-> SSL). If they differ, replace the file.

A TLS error from the server: check the CA file is in the image (`COPY server`
in `Dockerfile` ships `server/certs/`), that the URL has no `sslmode=`, and
that the CA has not expired or been rotated.

## Local dev trap: `docker compose down` leaves orphans

If a service is ever removed from `docker-compose.yml`, a plain `docker
compose down` does **not** stop a container it already started for that
now-deleted service — it keeps running, invisible to `docker compose ps`.
Use:

```sh
docker compose down --remove-orphans
```

as a habit, not just when you know something changed.
