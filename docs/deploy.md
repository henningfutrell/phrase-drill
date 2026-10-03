# Deploying to Render (T053)

For someone doing this once, with no memory of how `render.yaml` came to
look the way it does. Read `docs/server.md` first if you need the app's
endpoints, env vars, or its identity model — this document only covers
getting it running on Render.

Production runs on [Render](https://render.com), from `render.yaml` at the
repo root (a "Blueprint"). `docker-compose.yml` is **local dev only** —
Render does not read or run it. See `docs/server.md` for the local
`docker compose up` path.

**The service is `https://phrase-drill.onrender.com`.** Render's default
hostname from `render.yaml`'s `name: phrase-drill`. Measured 2026-08-24:
`curl -s https://phrase-drill.onrender.com/api/health` returns
`{"status":"ok"}`; `phrase-drill-app.onrender.com` and
`phrase-drill-web.onrender.com` both 404, so the name is unambiguous.

## Hard requirement: never the free Postgres tier

Render's free Postgres plan expires 30 days after creation and has **no
backups of any kind** — not "worse backups," none. Their phrase library would
be gone with no recovery path the day it happened to expire. `render.yaml`
already pins `plan: basic-256mb`; do not change it to `free`, and do not let
Render's dashboard "downgrade" prompt talk you into it.

**The backups that plan buys are the primary backup mechanism for this
app** — there is no scheduled off-site job anywhere in this repo, by
decision (T065). `docs/backup.md` documents what Render's managed backups
cover, the exact dashboard path to restore from one, and the failure they
do not cover.

## One-time setup

1. **Connect the repo.** In the Render dashboard: New → Blueprint → pick
   this GitHub repo, this branch (`main`). Render reads `render.yaml` and
   shows you the plan: one web service (`phrase-drill`, `docker`, plan
   `starter`) and one Postgres database (`phrase-drill-db`, plan
   `basic-256mb`), both in the `oregon` region.

2. **Set the two secrets.** `render.yaml` declares `ELEVENLABS_API_KEY` and
   `ANTHROPIC_API_KEY` with `sync: false`, which makes Render prompt for
   them during this same Blueprint-creation flow (a `sync: false` var is
   only prompted for at creation, not on every later sync — if you need to
   change one afterward, edit it directly on the service's Environment tab).
   Paste real values here; neither one is ever written to this repo.
   `DATABASE_URL` needs nothing from you — it's wired automatically from the
   database resource (`fromDatabase`, see the comment in `render.yaml`).

3. **Deploy.** Render builds the image from `Dockerfile` and starts it.
   `healthCheckPath: /api/health` is what Render polls to decide the
   deploy succeeded — watch the deploy log for a `200` from that path, or a
   failure it reports directly if the container never comes up.

4. **Create their account** in Supabase Auth (Dashboard → Authentication →
   Users → Add user, email + password, auto-confirm), with "Allow new users to
   sign up" off. There is no signup endpoint on this server. The server only
   verifies the access tokens Supabase issues (`docs/server.md`).

## Verify it worked

- **Health:** `curl https://phrase-drill.onrender.com/api/health` returns
  `{"status":"ok"}`.
- **Login:** load the app in Safari on the phone, log in with the account
  just created. A wrong password should be rejected; the right one should
  land on the drill screen.
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

## Postgres SSL — why this shouldn't come up, and what to check if it does

Render's managed Postgres has two hostnames for the same database: an
*internal* one (no domain suffix, private network only) and an *external*
one (`....<region>-postgres.render.com`, reachable from anywhere, requires
TLS). `render.yaml` wires `DATABASE_URL` via `fromDatabase: {property:
connectionString}`, which resolves to the **internal** URL when the web
service and the database share a region — both are pinned to `region:
oregon` in `render.yaml` for exactly this reason. An internal connection
needs no TLS at all, so this is expected to just work with no certificate
handling.

`server/db.js#sslConfigFor` is the code that decides this from
`DATABASE_URL` alone (no new env var): no `ssl` option for the internal
hostname (or `localhost`/`postgres`, the local `docker compose` case),
`ssl: { rejectUnauthorized: false }` **scoped to Render's external
hostname only** if you ever connect through it (e.g. a one-off `psql` from
your own laptop against the *External Database URL* shown in Render's
database dashboard, for a manual query or backup pull) — Render's
certificate chain isn't in Node's default CA trust store, which is a known,
documented Render/`node-postgres` interaction, not a general "skip TLS
verification" default. `server/db.test.js`'s `sslConfigFor` suite pins both
branches.

If a deploy nonetheless fails to reach Postgres with a TLS-shaped error,
first check that both resources in the Render dashboard show the *same
region* — if the database was ever recreated in a different region than the
web service, `connectionString` may resolve to the external hostname
instead, at which point `sslConfigFor` should still handle it (it matches on
hostname, not on internal-vs-external assumption), but it's worth
confirming the region match rather than treating that path as untested.

## Local dev trap: `docker compose down` leaves orphans

If a service is ever removed from `docker-compose.yml`, a plain `docker
compose down` does **not** stop a container it already started for that
now-deleted service — it keeps running, invisible to `docker compose ps`.
Use:

```sh
docker compose down --remove-orphans
```

as a habit, not just when you know something changed.
