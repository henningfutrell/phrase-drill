# The server (T041, T043)

Plain Node, no framework, no vendor SDK. Owns both provider credentials
(ElevenLabs speech, Anthropic vision) and her phrase library, so the device
never holds a key. `server/index.js` is the entry point; `server/app.js`
composes every route; both static PWA and API are served from the same
process and port.

Three services now, not one (T043): the app server, Postgres (its
persistence), and Keycloak in front of it (her login). See "Identity:
Keycloak login" and "Run locally" below.

## Why this exists

She has no physical access to her own phone and is not technical. Any UX that
asks her to paste an API key, pick a setting, or be walked through
configuration is unworkable. The server holds the keys; she logs in once with
a Keycloak account the owner created for her, and the device stays signed in.

## Endpoints

Every `/api/*` route requires `Authorization: Bearer <access-token>` — a
Keycloak-issued JWT, verified server-side (`server/jwt-verifier.js`) against
the realm's JWKS: signature, issuer, audience, and expiry. A missing,
malformed, unsigned, expired, or wrong-issuer/audience token is
`401 unauthorized` before any route-specific logic runs.

| Method | Path           | Purpose                                              | Body limit | Rate limit       |
| ------ | -------------- | ----------------------------------------------------- | ---------- | ----------------- |
| GET    | `/api/health`  | Liveness check, no auth required.                     | —          | none               |
| POST   | `/api/tts`     | Synthesize speech for one phrase (`{text, voiceId, modelId}` → audio/mpeg). | 8 KB       | 60 / 60s per key   |
| POST   | `/api/scan`    | Read handwritten phrases from an uploaded photo (image bytes → `{phrases}`). | 6 MB       | 10 / 60s per key   |
| GET    | `/api/library` | Fetch the stored library JSON for this key.           | —          | 30 / 60s per key   |
| PUT    | `/api/library` | Replace the stored library JSON for this key.         | 8 MB       | 30 / 60s per key   |
| \*     | anything else under `/api/` | `404 not-found`.                        | —          | —                  |
| \*     | anything not under `/api/`  | Falls back to the built PWA (`dist/`, SPA fallback to `index.html`). | — | — |

Rate limits are in-memory, per-process token buckets (`server/rate-limiter.js`)
— a restart resets every bucket to full; there is no distributed store to keep
in sync, which is the right failure direction for a single-container app.

**Why these numbers.** `/api/tts` and `/api/scan` are the two paid calls: 60/min
covers a normal drilling+scanning session with room to spare; 10/min on scan
reflects that a scan is a deliberate, occasional action (photographing a page),
never a background loop. `/api/library` is a device sync call, cheap and
frequent by nature (a push after every save/delete), so 30/min. Size caps: a
TTS request is one sentence (8 KB is generous); a scan is one downsized photo
(device caps ~1600px/JPEG q0.85, 6 MB is headroom); a library PUT is the whole
exported library (8 MB is ~6.5× the modelled 10,000-phrase export,
`docs/scale.md` §4).

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

## Identity: Keycloak login (T043)

The device-generated 64-hex library key is gone — deleted, not deprecated,
along with every caller of it (`SettingsScreen`'s Sync section, the old
`getLibraryKey` name on every adapter, `extractPassword`'s predecessor). Her
identity is now the Keycloak `sub` (subject claim) inside a signed access
token, the same identity model any real login uses.

**Login flow (browser):** authorization code + PKCE (S256), a public OAuth
client (`phrase-drill-app`) with no client secret anywhere — the PWA is a
static bundle anyone can read, so it can never hold one.
`src/adapters/auth/keycloak-auth.ts` drives it: `login()` full-page-redirects
to Keycloak's `/auth` endpoint with a PKCE challenge; Keycloak redirects back
with `?code=...&state=...`; `handleRedirectCallback()` exchanges the code for
tokens (validating `state` first, rejecting a mismatch as a possible CSRF or
stale redirect) and stores them.

**Session length vs. token length.** Access tokens are short (5 minutes,
realm default) — the server never trusts one longer than that. The realm's
session is what makes "never log in twice on one device" true: 30-day idle,
365-day max (`keycloak/realm-template.json`,
`workflows/web-app-development/phrase-drill/2026-08-02-bootstrap/notes/T042-keycloak-verified.md`).
`getAccessToken()` is the one thing every server-calling adapter uses — it
returns the cached token if it has more than 30s left, otherwise silently
exchanges the refresh token first (`grant_type=refresh_token`, still no
secret), so the 5-minute token length is invisible to her. Proven in
`src/adapters/auth/keycloak-auth.test.ts` with an injected clock: advance
virtual time to inside the 30s refresh window, assert the refresh grant fires
and the new token is what callers get.

**What someone holding a stolen access token can do, for up to 5 minutes:**
read and overwrite the library belonging to that token's `sub`
(`GET`/`PUT /api/library`), and spend that user's share of the rate-limited
TTS/Scan budget. They cannot read or derive the provider keys (the server
never returns them, see below), cannot affect another `sub`'s data — every
row in `libraries` is keyed by `sub`, and the server never trusts a `sub` a
token didn't itself carry — and cannot exceed the per-token rate limits.

**The VERIFY_PROFILE trap, and the decision.** Keycloak's default
`VERIFY_PROFILE` required action demands email/first/last name be complete
before login can finish — a trap for a realm with `registrationAllowed:
false` where the owner creates the one account by hand and can easily forget
to fill every field. Disabled realm-wide in `keycloak/realm-template.json`'s
`requiredActions` rather than relying on remembering to fill the fields at
account-creation time: deterministic regardless of *how* the account gets
created (admin console today, a REST script tomorrow), and there is exactly
one account in this realm, so nothing is lost by not collecting a profile
nobody reads.

**Existing IndexedDB decks still load.** The library-key identity was never
part of what's inside a `Deck`/`Phrase`/`Library` export — only
`SettingsStore` held it, purely for talking to the server. Removing it from
`Settings` (`src/adapters/storage/settings-store.ts`) leaves every decks
IndexedDB record untouched; `settings-store.test.ts` proves a settings
record with a legacy `libraryKey` field is read back with the field simply
ignored, not migrated or errored on.

## Provable: no key can leak

- `server/logger.js` redacts every secret out of every log field before a
  line is ever written to stdout: `ELEVENLABS_API_KEY`, `ANTHROPIC_API_KEY`,
  and (T043) the password segment of `DATABASE_URL`
  (`server/db.js#extractPassword`, pulled out once at startup and passed
  into `createLogger({ secrets: [...] })` alongside the provider keys).
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
- Access tokens themselves are bearer credentials, not server secrets — they
  are short-lived (5 minutes) and scoped to one `sub`; logging one is not the
  same failure class as logging a provider key, and none of the above claims
  they're redacted.

## Environment variables

| Var                    | Default                                                     | Meaning                                           |
| ----------------------- | ------------------------------------------------------------ | -------------------------------------------------- |
| `PORT`                  | `8080`                                                        | HTTP port.                                          |
| `DATABASE_URL`          | `postgres://phrase_drill:phrase_drill@localhost:5432/phrase_drill` | Postgres connection string for the app's own `libraries` table. |
| `DIST_DIR`               | `../dist` (relative to `server/`)                             | Built PWA to serve statically.               |
| `ELEVENLABS_API_KEY`     | unset                                                         | Speech generation returns `not-configured` if unset.|
| `ANTHROPIC_API_KEY`      | unset                                                         | Scan reading returns `not-configured` if unset.      |
| `KEYCLOAK_ISSUER`        | `http://localhost:8081/realms/phrase-drill`                   | Must equal the literal `iss` claim Keycloak puts in every token — the address the *browser* used to reach Keycloak, not necessarily reachable from inside the server's own container. |
| `KEYCLOAK_JWKS_URI`      | `http://localhost:8081/realms/phrase-drill/protocol/openid-connect/certs` | Where the server itself fetches signing keys — can (and in Docker Compose, does) use container-internal DNS even when `KEYCLOAK_ISSUER` can't. |
| `TOKEN_AUDIENCE`         | `phrase-drill-app`                                            | Must match the `aud` claim Keycloak puts in tokens (`keycloak/realm-template.json`'s audience mapper on the `phrase-drill-app` client). |

Build-time-only (baked into the static PWA bundle by Vite, not read at
server runtime — see `Dockerfile`'s builder-stage `ARG`s):
`VITE_KEYCLOAK_URL`, `VITE_KEYCLOAK_REALM`, `VITE_KEYCLOAK_CLIENT_ID`. These
are public OAuth client config, not secrets — a public client has none.

Secrets (`ELEVENLABS_API_KEY`, `ANTHROPIC_API_KEY`, the Postgres/Keycloak
admin passwords) come from the environment only — never committed, never
logged, never returned in a response or error body (see "Provable" above).
`.env.example` documents every variable this stack reads, with safe
local-only defaults; `docker-compose.yml`'s own defaults (`phrase_drill`/
`admin`) are for `docker compose up` on a laptop, never for anything
reachable off `localhost`.

## Schema: creation and change

`createLibraryStore(pool).init()` runs `CREATE TABLE IF NOT EXISTS libraries
(...)` on every boot (`server/db.js`) — idempotent, so a fresh database and
one that already has the table both end up in the same state with no
separate migration step to remember to run. This is deliberately the whole
story for now: one table, no columns added yet.

**How a future schema change is applied to a running deployment:** this
server has no migration runner (`node-pg-migrate`, `Flyway`, etc.) — adding
one is future work if `init()`'s `IF NOT EXISTS` approach stops being enough
(e.g. adding a column to `libraries` with a backfill, not just creating a
table that isn't there yet). Until then, a schema change ships as: (1) a
migration SQL step added to `init()` guarded by its own existence check
(e.g. `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`), so it's still safe to run
against both an old and an already-migrated database, then (2) redeploy —
Coolify (or `docker compose up --build`) restarts the `phrase-drill`
container, `init()` runs the guarded `ALTER`, the app comes back up. No
manual `psql` step, no downtime beyond a normal redeploy.

Keycloak owns its *own* schema inside the separate `keycloak` database
entirely — its own startup runs its own migrations. This server never
touches it.

## Run locally, no cloud account

```sh
docker compose up --build
```

Three services: Postgres (one instance, two logical databases —
`phrase_drill` for the app, `keycloak` for Keycloak's own accounts/sessions,
both created by `scripts/postgres/init-multi-db.sh` on Postgres's first
boot), Keycloak (production mode — `kc.sh start`, never `start-dev` — with
the realm imported from `keycloak/realm-template.json` at startup via
`scripts/keycloak/entrypoint.sh`), and the app itself. Serves the app at
`http://localhost:8080` and the Keycloak admin console at
`http://localhost:8081`.

With no provider keys set, the PWA, drilling cached Clips, and the phrase
library all work once logged in; Speech and Scan return a "not set up"
state until keys are added. Put real values in a git-ignored `.env` file
next to `docker-compose.yml` — copy `.env.example` and fill it in:

```sh
cp .env.example .env
# edit .env: real POSTGRES_PASSWORD, KEYCLOAK_ADMIN_PASSWORD,
# ELEVENLABS_API_KEY, ANTHROPIC_API_KEY
docker compose up --build
```

Log in for the first time by creating her account in the Keycloak admin
console (`http://localhost:8081`, `KEYCLOAK_ADMIN`/`KEYCLOAK_ADMIN_PASSWORD`)
under the `phrase-drill` realm — `registrationAllowed: false`, so there is no
self-service signup, by design (one user, owner-provisioned).

There is no non-Docker path any more: Postgres and Keycloak are real
services, not embeddable the way `node:sqlite` was, so `docker compose up`
is the only supported way to run this server locally.

## Deploy to Coolify

Point Coolify at this repository; it builds `docker-compose.yml` unchanged.
Steps:

1. New resource → Docker Compose → this repo, this branch.
2. Set `POSTGRES_PASSWORD`, `KEYCLOAK_ADMIN_PASSWORD`, `ELEVENLABS_API_KEY`,
   and `ANTHROPIC_API_KEY` in Coolify's environment variables UI — never in
   `docker-compose.yml` or committed anywhere.
3. Set `APP_REDIRECT_URI` to the real public origin plus `/*`
   (e.g. `https://phrase-drill.example.com/*`) — **never** a wildcard host
   like `https://*/*`, which the realm template refuses to ship with
   (`keycloak/realm-template.json`'s `redirectUris` is templated from this
   var, never hardcoded to a wildcard).
4. Set `VITE_KEYCLOAK_URL`/`KEYCLOAK_ISSUER` to Keycloak's real public URL
   once it has one (both must be the address the *browser* reaches, not a
   Docker-internal one).
5. Attach a persistent volume for `postgres-data` (declared in
   `docker-compose.yml`) so both the app's library table and Keycloak's own
   accounts/sessions survive a redeploy.
6. Expose port `8080` (the app) publicly; `8081` (Keycloak) only if the
   admin console needs to be reachable off the deploy network.

Create her account in the Keycloak admin console once, the same as local —
there's no migration path for an account, because there was never a
device-generated key to migrate away from on a deployment that starts here.

## Logs

One JSON line per event on stdout (`server/logger.js`): `{level, ts, msg,
...fields}`. Every inbound request logs one `"request"` line at `info` with
`method`, `path`, `status`, `ms`. `docker compose logs -f phrase-drill` (or
Coolify's log viewer) shows them as they happen. Every field is redacted
against both provider keys before the line is written, so a raw key can never
appear even if a deeper error message happened to contain one.
