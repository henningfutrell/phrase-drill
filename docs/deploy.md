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
backups of any kind** — not "worse backups," none. Her phrase library would
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

4. **Create her account.** There is no signup endpoint (`docs/server.md`),
   so the one account is created from a shell inside the running service:

   - Open the `phrase-drill` service in the Render dashboard → **Shell**
     tab. (This requires a paid instance type — `starter`, which
     `render.yaml` already sets. The free instance type has no Shell tab at
     all, which is one more reason not to drop to it.)
   - Run:
     ```sh
     node scripts/useradd.mjs her-username
     ```
     then type her password and press Enter, then Ctrl-D to close stdin (the
     script reads the password from stdin, never argv — same as the local
     `npm run useradd --` flow in `docs/server.md`, just invoked with `node`
     directly since the production image ships without `npm run`'s
     dev-dependency scripts but does still have `node` and the script
     itself — both `server/` and `scripts/useradd.mjs` are copied into the
     image by `Dockerfile`). `DATABASE_URL` is already set in the shell's
     environment, so no connection string needs to be pasted in by hand.
   - The script refuses instead of overwriting if the username already
     exists — safe to re-run by accident.

   **Unverified — no live Render account was used to write this task.**
   The Shell tab's interactive terminal is documented by Render as a real
   TTY reaching the running container, and `scripts/useradd.mjs`'s
   stdin-reading `readline` has no dependency on being a *local* terminal
   specifically — but this exact sequence has not been run against a real
   deployed instance. If the Shell tab turns out not to deliver a clean
   Ctrl-D/EOF, the fallback is Render's **one-off Job** feature (dashboard →
   Jobs → run `node scripts/useradd.mjs her-username` as a job command) —
   untested here for the same reason, and a one-off Job's non-interactive
   stdin makes the current stdin-based password prompt awkward (there is no
   terminal to type into). Try the Shell tab first; it needs no code change.

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
lands on `main` and needs to reach her phone.

**It does not reach her on its own, and the reason is structural.** The
service is linked to this repo by **public Git repository URL**, not through
a connected GitHub account — confirmed by the owner, 2026-08-24. Render's
docs are explicit: services using "a public Git repository URL ... must be
deployed manually"
([Deploys → Automatic deploys](https://render.com/docs/deploys#automatic-deploys)).
Auto-deploy is therefore **impossible by construction** for this service. No
dashboard setting turns it on, and no Blueprint sync binds it to
`render.yaml`.

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

**What this cost.** Two round trips through a non-technical user in another
country — 2026-08-04 (the drill-unlock fix) and 2026-08-24 (the Route hold) —
each to answer a question one `curl` answers in under a second, once the
service URL is known. See "How to tell what is actually deployed" below.

### Until it is fixed: Manual Deploy, every time

Render dashboard → the `phrase-drill` service → **Events** → **Manual
Deploy** → *Deploy latest commit*
([docs](https://render.com/docs/deploys#manual-deploys)). Then confirm with
the sha check below, not with the dashboard.

Do **not** reach for *Deploy a specific commit* unless you mean it: per
Render's docs that option **disables automatic deploys for the service**,
which matters the day the service is reconnected.

If a Manual Deploy does not produce a live build, the Render dashboard →
`phrase-drill` → **Logs** (or **Events**) tab shows whether the build or the
health check (`healthCheckPath: /api/health`) failed.

### The two ways to fix it, both needing the owner

1. **Reconnect the service through the GitHub account.** The real fix — it
   makes the service *eligible* for auto-deploy, at which point
   `render.yaml`'s declaration starts meaning something. **Warning: if Render
   requires the service to be recreated in order to change its repo link,
   recreating it loses the `fromDatabase` wiring for `DATABASE_URL` and both
   `sync: false` provider keys** (`ELEVENLABS_API_KEY`, `ANTHROPIC_API_KEY` —
   they exist only in Render's own store, never in this repo). So this is not
   obviously the safe option: check whether the repo link is editable in
   place before touching it.

2. **A GitHub Actions workflow that curls a deploy hook.** Every Render
   service has a **Deploy Hook URL** on its Settings page
   ([docs](https://render.com/docs/deploy-hooks)). A workflow at
   `.github/workflows/deploy.yml`, on `main` only, would run the gates
   (`npm test`, `npx tsc -b --force`, `npm run lint`, `npm run build`) and
   then `curl` the hook.

   **The hook URL is a secret.** It carries a `key=` query parameter, and
   anyone holding it can trigger a deploy. It belongs in a GitHub repository
   secret named `RENDER_DEPLOY_HOOK_URL` (repo → Settings → Secrets and
   variables → Actions). **Never commit it, and never write it into this
   file.**

   **Never call the hook with a `ref=` parameter.** Per Render's docs, a
   deploy-hook call naming a commit **disables automatic deploys for the
   service** — which would silently undo option 1 the moment it happened.

Neither is built. The workflow was deliberately not added: the secret does
not exist yet, and a workflow that cannot authenticate is worse than none.

### Related gap: this repo has no CI at all

1391 tests (2026-08-24) and **nothing runs them on push** — there is no
`.github/` directory in this repo. That is independent of deployment: a
broken `main` is found by whoever next runs `npm test` by hand. Option 2
above would close both gaps in one file, which is a reason to prefer it, not
a reason to conflate them.

### On her phone, once a new build is live

`docs/pwa.md` covers what happens to her open tab (`autoUpdate` takes it over
without a reload — see "Update strategy" there); nothing further to do on the
phone side.

The in-app path to the same fact: Settings → Diagnostics, where the `Build:`
line shows the deployed commit's short sha and a build timestamp. `unknown`
there means either the build predates `e6c561d` (every deploy before that
commit stamped `unknown` — see `build-sha.ts`) or `RENDER_GIT_COMMIT` was not
injected. **Read the sha with `curl` first; this path costs a round trip
through her.**

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

So the Route hold **is** on her phone, and the delivery mechanism is still
manual.

**Use this before asking her anything.** The Diagnostics path above reads the
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
