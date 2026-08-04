# The server (T041, T050)

Plain Node, no framework, no vendor SDK. Owns both provider credentials
(ElevenLabs speech, Anthropic vision) and her phrase library, so the device
never holds a key. `server/index.js` is the entry point; `server/app.js`
composes every route; both static PWA and API are served from the same
process and port.

Two services (T050): the app server and Postgres (its persistence). Login is
baked into the app itself — no third service, no vendor account, no admin
console to run for one person. See "Identity: session tokens" below.

## Why this exists

She has no physical access to her own phone and is not technical. Any UX that
asks her to paste an API key, pick a setting, or be walked through
configuration is unworkable. The server holds the keys; she logs in with a
username and password the owner set up for her, and the device stays signed
in for 30 days.

**Why not Keycloak (T050).** An earlier version of this server fronted login
with Keycloak — full OIDC, a hosted login page, its own Postgres schema. At
one non-technical user, the redirect dance, the vendor account, and the
memory it cost (measured: 760 MiB settled / 2.17 GiB peak — 97% of the
stack's memory, to log in one person) were cost with no matching benefit. A
login form inside the app is *simpler* for her than being bounced to a
third-party page, not just cheaper to run. Deleted entirely, not adapted:
`server/jwt-verifier.js`, `keycloak/`, `scripts/keycloak/`,
`src/adapters/auth/keycloak-auth.ts`, and every `KEYCLOAK_*`/`OIDC_*` env
var.

## Endpoints

Every `/api/*` route except `/api/login` requires `Authorization: Bearer
<session-token>` — an opaque token looked up against the `sessions` table
(`server/session-auth.js`). A missing, unknown, or expired token is `401
unauthorized` before any route-specific logic runs; an expired session row is
deleted the moment it's found, not left to expire on its own schedule.

| Method | Path           | Purpose                                              | Body limit | Rate limit       |
| ------ | -------------- | ----------------------------------------------------- | ---------- | ----------------- |
| GET    | `/api/health`  | Liveness check, no auth required.                     | —          | none               |
| POST   | `/api/login`   | `{username, password}` → `200 {token, expiresAt}` or `401` (identical body whether the username doesn't exist or the password is wrong — no leak). | 2 KB | 5 / 60s per username |
| POST   | `/api/logout`  | Deletes the session row for the bearer token, if any. Always `204`. | — | none |
| POST   | `/api/tts`     | Synthesize speech for one phrase (`{text, voiceId, modelId}` → audio/mpeg). | 8 KB       | 60 / 60s per session |
| POST   | `/api/scan`    | Read handwritten phrases from an uploaded photo (image bytes → `{phrases}`). | 6 MB       | 10 / 60s per session |
| POST   | `/api/translate` | Propose one or more Phrase Candidates translating one phrase (`{text, direction, deckName}` → `{candidates}`). | 4 KB | 30 / 60s per session |
| GET    | `/api/library` | Fetch the stored library JSON for this user.          | —          | 30 / 60s per session |
| PUT    | `/api/library` | Replace the stored library JSON for this user. `409 stale-client` if the body's `schemaVersion` is *lower* than the stored envelope's — see below. | 8 MB | 30 / 60s per session |
| \*     | anything else under `/api/` | `404 not-found`.                        | —          | —                  |
| \*     | anything not under `/api/`  | Falls back to the built PWA (`dist/`, SPA fallback to `index.html`). | — | — |

**Why `PUT /api/library` can answer 409 (T060).** The device pushes the whole
library, and the client merges the server copy into its own before pushing so
that neither device can erase what only the other had. That merge depends on
fields — `tombstones` above all — that only a client new enough to know about
them can carry. Her two devices do not update together, so for a window after
a deploy one of them is running an older bundle whose `exportAll()` silently
omits those fields; letting it write would strip the merge metadata off the
server copy and resurrect every Deck she had deleted. The server refuses that
one case and nothing else: a push at the same version or newer is accepted as
before. The refused device keeps its changes locally and syncs once it
updates.

Rate limits are in-memory, per-process token buckets (`server/rate-limiter.js`)
— a restart resets every bucket to full; there is no distributed store to keep
in sync, which is the right failure direction for a single-container app.
`/api/login`'s limiter is keyed by the *submitted username*, not the session
(there isn't one yet) — 5 attempts per 60s makes password guessing
impractical without punishing her for a typo.

Provider failures map to HTTP status: `not-configured` (no key set on the
server) → 503; `quota` (provider rate-limited us) → 429; `unreadable` (vision
model found no usable phrases) → 422; anything else → 502.

## Concurrency and retry

Every outbound call to a paid provider goes through a bounded queue
(`server/bounded-queue.js`), shared across every inbound request:

- ElevenLabs: concurrency 4
- Anthropic: concurrency 2

This is the fix for the `docs/scale.md` defect: the device used to fire one
request per phrase with no concurrency bound at all. Numbers are conservative
starting points for a single non-technical user's traffic, not a tuned
ceiling — Anthropic's vision calls are heavier per-request than a short TTS
call, hence the lower number.

Each provider call also retries with exponential backoff and jitter
(`server/retry.js`), retrying only `kind === 'quota'` (a 429) — a bad key or a
malformed request is never worth retrying:

- ElevenLabs: `baseMs=500`, `retries=2`, ±20% jitter
- Anthropic: `baseMs=800`, `retries=2`, ±20% jitter

## Identity: session tokens (T050)

Two tables, created idempotently on startup (`createAuthStore(pool).init()`
in `server/db.js`):

```
users    (id text primary key, username text unique not null,
          password_hash text not null, created_at bigint not null)
sessions (token_hash text primary key, user_id text not null,
          created_at bigint not null, expires_at bigint not null)
```

**Passwords.** Hashed with `node:crypto`'s `scrypt` (RFC 7914, the OpenSSL
binding — not a new dependency, not hand-rolled): a random ≥16-byte salt per
user, cost parameters embedded in the stored string (`scrypt:N:r:p:salt:hash`,
all base64) so they can be raised later without a format change. Compared
with `crypto.timingSafeEqual`, never `===` — a length or byte mismatch never
takes a data-dependent path. `server/session-auth.js` owns both
`hashPassword`/`verifyPassword`.

**Session tokens.** 32 random bytes (`crypto.randomBytes`), base64url-encoded,
handed to the browser once at login and stored in `localStorage`
(`src/adapters/auth/session-auth.ts`). The server never stores the token
itself — only its SHA-256 hash, so a database leak yields no usable token,
only lookups that fail. `POST /api/login` creates a row with `expires_at` 30
days out; every authenticated request looks the hash up, checks
`expires_at`, and deletes the row on the way out if it's past — both the
check and the cleanup happen in `server/session-auth.js#verify`, not two
separate code paths that could disagree.

**What someone holding a stolen session token can do, for up to 30 days or
until it's revoked:** read and overwrite the library belonging to that
token's user (`GET`/`PUT /api/library`), and spend that user's share of the
rate-limited TTS/Scan budget. They cannot read or derive the provider keys
(the server never returns them, see below), cannot see the password hash
(never sent to the client, ever), and cannot forge a session for a user they
don't hold a token for. `POST /api/logout` deletes the row outright —
immediate revocation, not just letting the token expire.

**Adding a user — CLI only, no signup endpoint.** There is no `/api/signup`;
an unauthenticated device has no way to create an account, by design (one
user, owner-provisioned).

```sh
npm run useradd -- her-username
# prompts for password on stdin — never pass it as an argv, it would land in
# shell history and `ps`
```

`scripts/useradd.mjs` refuses if the username already exists rather than
silently overwriting it — resetting a forgotten password is a deliberate CLI
action (delete the row, `useradd` again), not an accidental one.

**Existing IndexedDB decks still load.** Identity was never part of what's
inside a `Deck`/`Phrase`/`Library` export — only `SettingsStore` held a
device-identity field at all (the old library key, deleted at T043), and it's
already gone. This change touches nothing under `IndexedDB`.

## Accepted trade-offs, at two users

These are deliberate stopping points, not gaps someone forgot to close:

- **No password-reset flow.** If she forgets her password, the owner deletes
  her row directly in Postgres (or waits for a future `useradd --force`) and
  runs `npm run useradd` again. A self-service reset flow means email
  delivery, tokens, another surface to secure — for one user the owner can
  already reach.
- **No MFA.** A second factor protects an account worth attacking at scale;
  this one has a $0 bounty and one user.
- **30-day token, `localStorage`, until expiry or explicit revocation.** A
  stolen device keeps access until the token's 30 days run out or the owner
  deletes the session row by hand (there's no self-service "sign out other
  devices" — there's only ever one device). This is the same shape as most
  consumer apps' "stay signed in," accepted here for the same reason: the
  cost of re-entering a password from a share sheet on an iPhone, for a
  non-technical user, every few days, is real and the threat model (a
  physically lost or stolen phone that's also unlocked) is already covered by
  the phone's own lock screen.

## Provable: no key can leak

- `server/logger.js` redacts every secret out of every log field before a
  line is ever written to stdout: `ELEVENLABS_API_KEY`, `ANTHROPIC_API_KEY`,
  and the password segment of `DATABASE_URL`
  (`server/db.js#extractPassword`, pulled out once at startup and passed
  into `createLogger({ secrets: [...] })` alongside the provider keys).
  `handleLogin` never passes the submitted password to the logger in any
  field, on any path — proven in `server/app.test.js`'s login tests.
- `server/app.test.js`'s `describe('secrets never leak', ...)` drives every
  route with both provider secrets configured and asserts neither raw key
  string appears in any response body or any captured log line, across every
  success and failure path (including a `not-configured` response with no key
  set, so an *absent* key's placeholder can't leak either).
- `server/logger.test.js` proves the redaction primitive directly: a known
  secret in a log message or a field value is replaced with `[REDACTED]`.
- `server/db.test.js`'s `describe('extractPassword', ...)` proves the
  connection-string password extraction directly: pulls the password out of
  a well-formed URL, returns `null` for a connection string with no password
  segment and for an unparsable string, never throws.
- Password hashes never leave `server/db.js` — `getUserByUsername` is used
  only inside `session-auth.js#login` for the `verifyPassword` comparison,
  never returned in any HTTP response.
- Session tokens themselves are bearer credentials, not server secrets — the
  server stores only their hash and they're scoped to one user; logging one
  is not the same failure class as logging a provider key or a password, and
  none of the above claims they're redacted.

## Environment variables

| Var                    | Default                                                     | Meaning                                           |
| ----------------------- | ------------------------------------------------------------ | -------------------------------------------------- |
| `PORT`                  | `8080`                                                        | HTTP port.                                          |
| `DATABASE_URL`          | `postgres://phrase_drill:phrase_drill@localhost:5432/phrase_drill` | Postgres connection string for `libraries`, `users`, `sessions`. |
| `DIST_DIR`               | `../dist` (relative to `server/`)                             | Built PWA to serve statically.               |
| `ELEVENLABS_API_KEY`     | unset                                                         | Speech generation returns `not-configured` if unset.|
| `ANTHROPIC_API_KEY`      | unset                                                         | Scan reading returns `not-configured` if unset.      |

That's the whole list (T050) — no login-provider config, no build-time
`VITE_*` client id/realm to bake into the PWA, nothing else to set.

Secrets (`ELEVENLABS_API_KEY`, `ANTHROPIC_API_KEY`, the Postgres password)
come from the environment only — never committed, never logged, never
returned in a response or error body (see "Provable" above). `.env.example`
documents every variable this stack reads, with safe local-only defaults;
`docker-compose.yml`'s own defaults (`phrase_drill`/`phrase_drill`) are for
`docker compose up` on a laptop, never for anything reachable off
`localhost`.

## Schema: creation and change

`createLibraryStore(pool).init()` and `createAuthStore(pool).init()` both run
`CREATE TABLE IF NOT EXISTS` on every boot (`server/db.js`) — idempotent, so
a fresh database and one that already has the tables both end up in the same
state with no separate migration step to remember to run.

**How a future schema change is applied to a running deployment:** this
server has no migration runner (`node-pg-migrate`, `Flyway`, etc.) — adding
one is future work if `init()`'s `IF NOT EXISTS` approach stops being enough
(e.g. adding a column with a backfill, not just creating a table that isn't
there yet). Until then, a schema change ships as: (1) a migration SQL step
added to `init()` guarded by its own existence check (e.g. `ALTER TABLE ...
ADD COLUMN IF NOT EXISTS`), so it's still safe to run against both an old and
an already-migrated database, then (2) redeploy — Coolify (or `docker compose
up --build`) restarts the `phrase-drill` container, `init()` runs the guarded
`ALTER`, the app comes back up. No manual `psql` step, no downtime beyond a
normal redeploy.

## Run locally, no cloud account

```sh
docker compose up --build
```

Two services: Postgres and the app. Serves the app at
`http://localhost:8080`.

With no provider keys set, the PWA, drilling cached Clips, and the phrase
library all work once logged in; Speech and Scan return a "not set up" state
until keys are added. Put real values in a git-ignored `.env` file next to
`docker-compose.yml` — copy `.env.example` and fill it in:

```sh
cp .env.example .env
# edit .env: real POSTGRES_PASSWORD, ELEVENLABS_API_KEY, ANTHROPIC_API_KEY
docker compose up --build
npm run useradd -- her-username   # once, to create her account
```

There is no non-Docker path any more: Postgres is a real service, not
embeddable the way `node:sqlite` was, so `docker compose up` is the only
supported way to run this server locally.

## Deploy to production

Production runs on Render (T053), from `render.yaml` at the repo root — not
`docker-compose.yml`, which Render doesn't read; that file is local-dev
only (see its own header). An earlier version of this doc pointed at
Coolify running `docker-compose.yml` unchanged; that was never actually
deployed and is superseded outright, not kept as an alternate path. The
whole deploy — connecting the repo, the two secrets, creating her account,
what to check afterward, and the Postgres SSL reasoning specific to
Render's managed database — is `docs/deploy.md`.

## Logs

One JSON line per event on stdout (`server/logger.js`): `{level, ts, msg,
...fields}`. Every inbound request logs one `"request"` line at `info` with
`method`, `path`, `status`, `ms`. `docker compose logs -f phrase-drill` (or
Coolify's log viewer) shows them as they happen. Every field is redacted
against both provider keys and the database password before the line is
written, so a raw secret can never appear even if a deeper error message
happened to contain one.
