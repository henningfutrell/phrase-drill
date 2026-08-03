# The server (T041)

Plain Node, no framework, no vendor SDK. Owns both provider credentials
(ElevenLabs speech, Anthropic vision) and her phrase library, so the device
never holds a key. `server/index.js` is the entry point; `server/app.js`
composes every route; both static PWA and API are served from the same
process and port.

## Why this exists

She has no physical access to her own phone and is not technical. Any UX that
asks her to paste an API key, pick a setting, or be walked through
configuration is unworkable. The server holds the keys; she holds a sync key
that identifies her library, nothing more.

## Endpoints

Every `/api/*` route requires `Authorization: Bearer <library-key>` — 64
lowercase hex characters. A missing or malformed key is `401 unauthorized`
before any route-specific logic runs.

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

## Identity: the library key

64 lowercase hex characters, 256 bits of entropy, generated on-device
(`crypto.getRandomValues`) the first time `SettingsStore.load()` runs, and
shown unmasked in Settings with a Copy button — this is the whole recovery
story for a wiped or replaced phone. There are no accounts, no passwords, no
email. A second person given the key is a second identity on the server, full
stop.

**What someone holding a library key can do:** read and overwrite everything
stored under it — her whole phrase library (`GET`/`PUT /api/library`) — and
spend her share of the rate-limited TTS/Scan budget. They cannot read or
derive the provider keys (the server never returns them, see below), cannot
affect another library key's data, and cannot exceed the per-key rate limits.
Treat the key like a house key: anyone who has it can read and change what's
inside, and it's not revocable except by having the device generate/adopt a
different one.

## Provable: no key can leak

- `server/logger.js` redacts both provider keys out of every log field before
  a line is ever written to stdout (`ELEVENLABS_API_KEY`/`ANTHROPIC_API_KEY`
  are passed to `createLogger({ secrets: [...] })` once, at startup).
- `server/app.test.js`'s `describe('secrets never leak', ...)` drives every
  route with both secrets configured and asserts neither raw key string
  appears in any response body or any captured log line, across every
  success and failure path (including a `not-configured` response with no key
  set, so an *absent* key's placeholder can't leak either).
- `server/logger.test.js` proves the redaction primitive directly: a known
  secret in a log message or a field value is replaced with `[REDACTED]`.

## Environment variables

| Var                    | Default                    | Meaning                                           |
| ----------------------- | --------------------------- | -------------------------------------------------- |
| `PORT`                  | `8080`                      | HTTP port.                                          |
| `DB_PATH`                | `./data/phrase-drill.db`    | SQLite file (`node:sqlite`). Put it on a volume.    |
| `DIST_DIR`               | `../dist` (relative to `server/`) | Built PWA to serve statically.               |
| `ELEVENLABS_API_KEY`     | unset                       | Speech generation returns `not-configured` if unset.|
| `ANTHROPIC_API_KEY`      | unset                       | Scan reading returns `not-configured` if unset.      |

Secrets come from the environment only — never committed, never logged, never
returned in a response or error body (see "Provable" above).

## Run locally, no cloud account

```sh
docker compose up --build
```

Serves the app at `http://localhost:8080`. With no keys set, the PWA, drilling
cached Clips, and the phrase library all work; Speech and Scan return a
"not set up" state until keys are added. To exercise them, put real keys in a
git-ignored `.env` file next to `docker-compose.yml`:

```
ELEVENLABS_API_KEY=...
ANTHROPIC_API_KEY=...
```

Or without Docker, from the repo root (Node 26+ for `node:sqlite`):

```sh
npm run build
ELEVENLABS_API_KEY=... ANTHROPIC_API_KEY=... node server/index.js
```

## Deploy to Coolify

Point Coolify at this repository; it builds `Dockerfile` unchanged. Steps:

1. New resource → Docker Compose (or Dockerfile) → this repo, this branch.
2. Set `ELEVENLABS_API_KEY` and `ANTHROPIC_API_KEY` in Coolify's environment
   variables UI — never in `docker-compose.yml` or committed anywhere.
3. Attach a persistent volume at `/data` (the compose file already declares
   the named volume `phrase-drill-data` mounted there) so the library
   database survives a redeploy.
4. Expose port `8080`.

No other configuration — `DB_PATH`/`DIST_DIR`/`PORT` already default to the
values this setup expects.

## Logs

One JSON line per event on stdout (`server/logger.js`): `{level, ts, msg,
...fields}`. Every inbound request logs one `"request"` line at `info` with
`method`, `path`, `status`, `ms`. `docker compose logs -f phrase-drill` (or
Coolify's log viewer) shows them as they happen. Every field is redacted
against both provider keys before the line is written, so a raw key can never
appear even if a deeper error message happened to contain one.
