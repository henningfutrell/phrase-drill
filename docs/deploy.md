# Deploying to Render (T053)

For someone doing this once, with no memory of how `render.yaml` came to
look the way it does. Read `docs/server.md` first if you need the app's
endpoints, env vars, or its identity model — this document only covers
getting it running on Render.

Production runs on [Render](https://render.com), from `render.yaml` at the
repo root (a "Blueprint"). `docker-compose.yml` is **local dev only** —
Render does not read or run it. See `docs/server.md` for the local
`docker compose up` path.

## Hard requirement: never the free Postgres tier

Render's free Postgres plan expires 30 days after creation and has **no
backups of any kind** — not "worse backups," none. Her phrase library would
be gone with no recovery path the day it happened to expire. `render.yaml`
already pins `plan: basic-256mb`; do not change it to `free`, and do not let
Render's dashboard "downgrade" prompt talk you into it.

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

- **Health:** `curl https://<your-service>.onrender.com/api/health` returns
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
