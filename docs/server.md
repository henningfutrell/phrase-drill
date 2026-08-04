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
| POST   | `/api/tts`     | Speech for one phrase (`{text, voiceId, modelId, provider, lang}` → audio/mpeg), served from the shared Clip store when it holds it — see below. All five fields are required. | 8 KB       | 60 / 60s per session |
| POST   | `/api/scan`    | Read handwritten phrases from an uploaded photo (image bytes → `{phrases}`). | 6 MB       | 10 / 60s per session |
| POST   | `/api/translate` | Propose one or more Phrase Candidates translating one phrase (`{text, direction, deckName}` → `{candidates}`). | 4 KB | 30 / 60s per session |
| GET    | `/api/library` | Fetch the stored library JSON for this user. `500 library-unreadable` if the stored row will not parse as a library envelope — a contract the device acts on, see below. | —          | 30 / 60s per session |
| PUT    | `/api/library` | Replace the stored library JSON for this user, keeping the version it replaces. `409 stale-client` if the body's `schemaVersion` is *lower* than the stored envelope's — see below. | 8 MB | 30 / 60s per session |
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

## The library is kept recoverable, not defended (T071)

This server holds the only off-device copy of a library that cannot be
recreated. Before T071 a `PUT` replaced it wholesale and the version it
replaced stopped existing: `PUT {format, schemaVersion, decks: []}` — a
client bug, a half-migrated device, a bad merge — answered `204` and the
previous contents were gone from the last place they were. Only Render's own
managed backup stood behind that.

**What was built is recoverability, and deliberately not refusal.** Two
reasons, and the second is the decisive one:

- The server cannot judge the push. A smaller library is exactly what
  deleting a deck looks like, and she is allowed to delete a deck. Any
  content rule strict enough to catch the bad push also catches the real
  one, and *a refusal she cannot get past is its own failure*.
- The device turns an unrecognised refusal into an infinite retry.
  `library-sync-client.ts` maps `401` → `unauthorized`, `404` →
  `not-found`, `409` → `stale-client`, and **everything else → `network`**,
  which the sync engine retries with backoff forever. A new refusal status
  would therefore present to her as a sync line that says "waiting" and
  never finishes, while everything she writes stays on the phone. That is a
  worse failure than the one it guards, and it cannot be fixed here — it
  needs the client to learn the status first.

So every well-formed push is still accepted. What changed is that the
version it replaces is kept:

```
library_versions (id BIGSERIAL PRIMARY KEY, library_key TEXT NOT NULL,
                  data TEXT NOT NULL, updated_at BIGINT NOT NULL,
                  archived_at BIGINT NOT NULL)
```

**Archiving is the store's invariant, not the route's.** It happens inside
`libraryStore.put` (`server/db.js`), before the overwrite, so there is no
code path — route, script, future caller — that can replace the only copy by
forgetting a step.

**Archive and overwrite are one transaction, and the row is locked before it
is read** (`BEGIN`, `SELECT … FOR UPDATE`, archive, overwrite, `COMMIT`).
Before T082 they were separate autocommitted statements, and the paragraph
here claimed no code path could replace the only copy. That claim was about a
*crash* between the statements and it did not survive *interleaving*: two
requests both read the same previous version, both archived it, and the
second overwrote the first — so one device's push was in neither table. Both
her phones sync on the same triggers (launch, reconnect, the phone being
locked), so that is the ordinary case. The statement order still matters and
is unchanged, so a crash or a rollback leaves the previous version in place,
never both gone. One residual, bounded: `FOR UPDATE` locks a row that
exists, so two concurrent puts for a key with *no row yet* still race —
nothing the server ever held is lost, and it is reachable only on the
first-ever write for an account.

**Every replaced version is archived. The hourly throttle is applied to
retention, not to the write** (T082). A push whose bytes are identical to
what is stored still archives nothing.

The throttle used to be on `put`: at most one archive per hour per key. The
reasoning was right and is kept — the tempting rule is "archive whenever the
push shrinks the library", and it is worse, because a bad push repeated then
archives its own shrunken states and prunes the good one out of the window,
whereas an interval cannot be accelerated by any push pattern at all. What
was wrong was the *place*. The client debounces at 2 s and pushes per edit,
so an hour of ordinary editing is ~1,800 pushes and exactly **one** archive —
of the *oldest* state in the window. Everything she typed after the first
push of the hour lived in the live row and nowhere else, and a wipe inside
the window took the lot, with two 204s and no log line.

**Retention, in order: thin, then budget.**

1. **Thinning.** The newest 8 archived versions are kept whatever the push
   rate. Everything older collapses to the **oldest** row per hour — the
   state a burst began from, which is what is worth recovering. A flood
   therefore still cannot flush the aged history.
2. **Budgets: 72 versions or 32 MB per key, whichever binds first, and never
   the last one.** 72 hourly rows is three days of history. 32 MB is ~26
   copies of the largest library `docs/scale.md` models (1.2 MB at 10,000
   Phrases) or ~250 copies of a 1,000-Phrase one, against the deployed plan's
   1 GB — so a big library trades depth for size automatically instead of
   quietly filling the disk `clips` shares. The 8 recent rows are exempt from
   thinning, never from the budgets. The newest archived version is never a
   prune candidate however large it is.

**`schemaVersion` is bounded, and what is stored is what was validated**
(T082). A push is refused with 400 unless its `schemaVersion` is an integer
in `1 .. LIBRARY_MAX_SCHEMA_VERSION` (`server/app.js`, kept equal to the
client's `CURRENT_SCHEMA_VERSION` — they are one build and one deploy).

Two things this closes. `1e999` is legal JSON, parses to `Infinity`, and
`typeof Infinity === 'number'`, so the old shape test passed it; the row was
then written as `JSON.stringify(parsed)`, which emits `"schemaVersion":null`,
and every later `GET` failed the *same* shape test on the way out and
answered 500 `library-unreadable` — over a row that had already replaced
hers, forever. And `schemaVersion` gates every push, so one stored rogue
value (999, a replayed body, a hand `curl`) 409'd every honest push from both
phones for good. The route now stores the request's own bytes rather than a
re-serialization of them, so "byte for byte, not re-serialized" is true of
the write path as well as the read path.

A row already holding an out-of-range version is not a manual repair:
`storedSchemaVersion` reads anything outside the accepted range as `0`, so
her next honest push is accepted and archives the bad bytes on the way past.

### Recovering a library a bad push destroyed

There is no endpoint and no CLI for this yet — it is a `psql` session
against the database (Render dashboard → the database → Connect, or
`docker compose exec postgres psql -U phrase_drill`). Her `library_key` is
the `users.id` of her account.

```sql
-- What is retained, newest first.
SELECT id, updated_at, archived_at, octet_length(data) AS bytes
FROM library_versions
WHERE library_key = (SELECT id FROM users WHERE username = 'her-username')
ORDER BY id DESC;

-- Look before restoring: how many decks each version holds.
SELECT id, archived_at, jsonb_array_length((data::jsonb)->'decks') AS decks
FROM library_versions
WHERE library_key = (SELECT id FROM users WHERE username = 'her-username')
ORDER BY id DESC;

-- Restore one. Archives the bad row on the way past, because `put`'s rule
-- is the store's, not this statement's — so do it through the app if you
-- can. Directly, the bad row must be preserved by hand first:
INSERT INTO library_versions (library_key, data, updated_at, archived_at)
SELECT library_key, data, updated_at, (extract(epoch from now()) * 1000)::bigint
FROM libraries WHERE library_key = '<her-user-id>';

UPDATE libraries
SET data = (SELECT data FROM library_versions WHERE id = <chosen-id>),
    updated_at = (extract(epoch from now()) * 1000)::bigint
WHERE library_key = '<her-user-id>';
```

Then the device merges it back down on its next sync. Note the interaction
with `AUDIT-T068` finding 1: the client's three-way merge reads "present
only on my side, unchanged from the baseline" as *the server deleted it*, so
a server rollback can make the phone delete newer phrases. Restoring an old
version is the same move as the `pg_dump` restore drill, and carries the same
hazard until that finding is fixed.

### When the stored row itself will not parse

`GET /api/library` used to answer `res.end(row.data)` with no validation at
all. A row that will not parse — hand-repaired, half-restored, truncated
upstream — came back as a `200` claiming to be a library; the device called
`response.json()` on it, that threw, and the sync engine died for the rest of
the session while the UI still said "syncing" (`AUDIT-T068` finding 2).
Everything written after that stayed on the phone.

It now parses and shape-checks the row before serving it — the same envelope
test a `PUT` body must pass — and answers `500 {"error":"library-unreadable"}`
otherwise, with an `error`-level log line carrying the key, the byte count and
`updated_at`. `500` is the honest status — the fault is this server's, not the
request's — and it is also a *handled* result at the device rather than an
exception nothing catches.

**The row is not repaired, deleted or overwritten by the read path.** It is
the last copy of something even when what it is is unreadable. A `PUT` may
still replace it — `storedSchemaVersion` answers `0` for an unparseable row,
deliberately, so a corrupt row can never lock her out of syncing — and that
`PUT` archives the corrupt bytes into `library_versions` on the way past.

#### `library-unreadable` is a contract, not a log line (T089)

The body matters as much as the status. `500 {"error":"library-unreadable"}`
is the **only** thing this server says that is a verdict on its own stored
bytes rather than on the request, and the device reads it as exactly that: a
pull that returns it is the one pull failure after which the phone is allowed
to push (`src/adapters/sync/library-sync-client.ts` →
`server-copy-unreadable`, `docs/sync.md`). That is what makes a poisoned row
repairable — the `PUT` path above was already open, and until T089 nothing
ever walked through it, because a pull that failed skips the push and the
intact library on her phone could never go back up.

So this string is load-bearing. Answering `404` here instead was considered
and refused (T082, upheld T089): `404` means "no server copy", the device
already has a meaning for it, and conflating the two throws away the one loud
signal that a row needs looking at. Answering a *generic* `500` — the
catch-all `{"error":"server-error"}` — is not the same thing either, and the
device treats it as `network` and does not push, because a server that fell
over says nothing about the row it holds. Rename or drop the code and sync
silently stops repairing itself; both sides assert the literal
(`server/app.test.js`, `src/adapters/sync/library-sync-client.test.ts`).

A valid response is still served byte for byte out of the stored row, not
re-serialized, so nothing here can quietly reshape what she stored.

Rate limits are in-memory, per-process token buckets (`server/rate-limiter.js`)
— a restart resets every bucket to full; there is no distributed store to keep
in sync, which is the right failure direction for a single-container app.
`/api/login`'s limiter is keyed by the *submitted username*, not the session
(there isn't one yet) — 5 attempts per 60s makes password guessing
impractical without punishing her for a typo.

Provider failures map to HTTP status: `not-configured` (no key set on the
server) → 503; `quota` (the provider is out of credits) → **402**;
`unreadable` (vision model found no usable phrases) → 422; anything else →
502.

## 429 is ours, 402 is the provider's (T035)

**This server answers 429 for exactly one reason: its own limiter.** Every
such response carries `Retry-After`, in seconds, computed from the bucket
itself (`allow()` returns the wait, not a bare boolean) — the client cannot
derive that number, because it cannot see how full the bucket is.

**A provider running out of credits answers 402.** They used to share 429, and
that collapse is the defect T035 fixed. Measured, on a cold 1,000-Phrase
library: the device issued ~2,000 simultaneous requests, the first ~60 passed
the limiter, and the other ~1,940 came back 429 and were marked permanently
`quota`-failed — by *us*, not by ElevenLabs. The device could not tell "wait a
moment" from "this will never succeed", so it treated both as the latter.

The two are different facts with different remedies and they now have
different statuses:

| | Status | What it means | What a client does |
|---|---|---|---|
| this server's limiter | `429` + `Retry-After` | asking too fast | wait exactly that long, then retry |
| provider out of credits | `402` | somebody has to pay | stop; retrying cannot succeed |

Why the status and not a field in the body: a `/api/tts` success is audio
bytes, so the client branches on status alone and never parses a body on the
happy path. `Retry-After` is RFC 9110's own field, readable by anything
between here and the device — a log, a proxy, `curl` — where a private JSON
key would not be. 402 is used nowhere else in this API, so nothing else can
produce it by accident.

**The device holds up its end** (`src/adapters/audio/generation-queue.ts`): at
most 4 requests in flight, and a 429 pauses the *whole* queue until
`Retry-After` elapses rather than only the request that hit it — the limiter
is per session, so every other request in flight would be refused for the same
reason. Waits are bounded (50 per Clip), so a sweep always terminates; a Clip
that runs out of them ends `failed`, which the UI can show, not silently
missing.

## The shared Clip store (T063)

`/api/tts` looks a Clip up before it calls ElevenLabs. On a miss it calls the
provider, writes the bytes through, and returns them; on a hit it returns the
stored bytes and makes no provider call at all. One table:

```
clips (hash TEXT PRIMARY KEY, bytes BYTEA NOT NULL, mime TEXT NOT NULL,
       duration_ms BIGINT NOT NULL, created_at BIGINT NOT NULL,
       byte_size BIGINT)
```

**Why.** Before this the route was a straight proxy, so the same phrase in the
same voice was generated and paid for again on every device and after every
reinstall. The device's IndexedDB cache stays exactly as it was — it is what
makes the drill work offline — but it is now a local copy of a shared store
rather than the only copy there is.

**Postgres `bytea`, not an object store.** One user, a few thousand clips at
~10-30 KB: tens of megabytes, in a database this stack already runs. An object
store would be a second service to run, a second credential to rotate, and a
second thing to be down.

**The server derives the content address; it does not trust one the client
sends.** The address is SHA-256 of `provider|modelId|voiceId|lang|text`, which
is the same material `src/adapters/storage/clip-cache.ts` uses for the device
cache. A client-supplied key would be an assertion the server cannot check —
"these bytes are what this address means" — and one bad build would write the
wrong audio under a good address for *every* device, permanently and silently,
because a cache is never re-checked against what it caches. Deriving it here
makes the address a function of the request the server itself made.

The cost is two implementations of one derivation, which can drift.
`src/adapters/storage/clip-hash-parity.integration.test.ts` imports both and
compares them, so neither can change alone. This is why `/api/tts` now requires
`provider` and `lang`, which the ElevenLabs call itself has no use for.

**A cache hit still spends rate-limit budget.** The limiter stays in front of
the route. A hit is a smaller cost, not no cost — an authenticated request, a
database read, ~20 KB streamed back — and making hits free would put an
un-metered path behind a bearer token (see the stolen-token trade-off above).
So a device sweeping a whole library still meets the 60/60s ceiling on the
second device exactly as it did on the first. Since T035 that ceiling is a
pace, not a wall: the sweep drains at one Clip per second instead of dying on
it, and it no longer pays ElevenLabs to get there.

**A failed write does not fail the request.** The bytes are already generated
and already paid for; the caller gets them, and the failure is logged. The
same is true of a failed eviction — it happens inside `clipStore.put`, whose
errors this route already swallows and logs.

### The ceiling on it (T071)

As shipped, `clips` had no eviction, no TTL and no `DELETE` anywhere in
`server/` or `scripts/`, on the *same* managed Postgres as `libraries`.

**The numbers.** `docs/scale.md` §1 models ~89 KB of audio per Phrase (two
Clips). The deployed plan is `basic-256mb` (`render.yaml`) — 1 GB of storage:

| Library | Clip bytes, live set only | Share of a 1 GB disk |
|---:|---:|---:|
| 100 Phrases | 8.8 MB | 1% |
| 1,000 Phrases | 86.4 MB | 8% |
| 5,000 Phrases | 424.7 MB | 42% |
| 10,000 Phrases | 847.8 MB | **83%** |

Those are the *live* rows. Nothing removed the dead ones: the address is a
hash of `provider|modelId|voiceId|lang|text`, so re-pinning a voice,
correcting a phrase, or a provider model change moves every affected Clip to
a new address and leaves the old row forever. **One voice change on a
5,000-Phrase library is 850 MB in a 1 GB database, from a single UI action.**
The library JSON beside it is 1.2 MB at its modelled worst.

**So a bound is needed now, not later** — the failure it prevents is not
"audio gets slow". When the disk fills, the write that starts failing is
`libraryStore.put` → `500` → the client's `push` returns `network` → the
engine retries forever and the sync line says "waiting". Her phrases stop
reaching the server while the app looks healthy, and the `pg_dump` backup
grows and slows until it fails too. Audio is derived and regenerable; the
phrases are not. The table that can grow without limit is the one that gets
cut.

**The bound.** 300 MB, `DEFAULT_CLIP_STORE_MAX_BYTES` in `server/db.js`,
overridable with `CLIP_STORE_MAX_BYTES`. Chosen so that it is more than
either device's own 200 MB cache can hold (T036) — the server is never the
smaller cache — while leaving ~65% of the disk for `libraries`,
`library_versions`, WAL and Postgres's own overhead. Crossing it on a `put`
evicts down to 90% of it, the same hysteresis the device's cache uses, so one
sweep is not one delete per write.

**A malformed `CLIP_STORE_MAX_BYTES` falls back to the default, loudly**
(T082, `clipStoreMaxBytesFrom`). It used to reach the store through a bare
`Number(...)`, and this value is only ever set by typing into a deploy
dashboard field: `'300MB'` gave `NaN`, every comparison against which is
false, so the store was **unbounded** — `clips` fills the 1 GB instance and
the write that starts failing is `libraryStore.put`, i.e. her phrases stop
reaching the server while the sync line still reads "waiting". `''` gave `0`,
so every put evicted everything. Anything that is not a whole number of bytes
at or above 128 KB is now refused and the documented default used instead,
with one `error` line at boot naming what was provided. It does not refuse to
boot: this process holds the only off-device copy of her library, and serving
`GET /api/library` is exactly what a misconfigured deploy must not take away.

**Oldest-first, on the `created_at` the table already carried.** Least
recently *played* is better policy and would cost a column plus a write on
every cache hit. On the server a wrongly evicted Clip is one regeneration; on
the device it is a drill that cannot start offline — which is why the
device's cache is the LRU one (`docs/scale.md` §6) and this one is not.

**It cannot reach `libraries`.** Every statement the Clip store issues names
`clips` literally, and no identifier is ever interpolated, so the set of
tables this code can touch is closed. `server/db.test.js` asserts that over
every query the store issues under eviction, not just the ones a test
happened to think of.

`byte_size` is why the sweep is cheap: summing a narrow integer column is a
scan of the heap tuples. `SUM(octet_length(bytes))` would detoast every Clip
on every cache miss, and `pg_total_relation_size` does not shrink after a
`DELETE` until `VACUUM` — using it would make the loop empty the table.

## Concurrency and retry

Every outbound call to a paid provider goes through a bounded queue
(`server/bounded-queue.js`), shared across every inbound request:

- ElevenLabs: concurrency 4
- Anthropic: concurrency 2

This bounds what reaches a provider once a request is *inside* the server. It
never paced the inbound sweep, because it sits behind the limiter — the device
bounding itself to 4 in flight (T035) is the other half, and the necessary
one. Numbers are conservative
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
| `PORT`                  | `8080`                                                        | HTTP port. Parsed, not coerced (T088): anything that is not a whole number in 1–65535 — including an empty or cleared value, which `Number('')` reads as `0` and `listen(0)` turns into a RANDOM free port — logs an error and falls back to `8080`. |
| `DATABASE_URL`          | `postgres://phrase_drill:phrase_drill@localhost:5432/phrase_drill` | Postgres connection string for `libraries`, `library_versions`, `users`, `sessions`, `clips`. |
| `CLIP_STORE_MAX_BYTES`  | `314572800` (300 MB)                                          | Ceiling on the shared Clip store; crossing it evicts oldest-first to 90%. Raise it with the database plan, never above what leaves `libraries` room. |
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

## Staying up, and going down on purpose (T088)

This process holds the only off-device copy of her library, so the ways it can
END are worth as much attention as the ways it can be wrong. Three were
reachable in ordinary operation; all three are closed:

- **A database blip no longer kills the app.** `pg` re-emits an idle client's
  failure on the pool, and Node terminates a process on an `'error'` event with
  no listener — so a Postgres failover, a restart, or a middlebox resetting an
  idle connection took the whole server down, possibly mid-push. `createPool`
  (`server/db.js`) listens and logs. That is all it does on purpose: `pg` has
  already discarded the bad client, and the next query opens a fresh
  connection, so reconnection logic here would only duplicate the pool.
- **SIGTERM drains instead of cutting.** Render sends SIGTERM on every deploy
  and restart. `server/shutdown.js` stops accepting new connections, lets the
  in-flight requests finish (a `PUT /api/library` among them), closes the idle
  keep-alive sockets that would otherwise stall the drain, then ends the pool —
  once. A request that will not finish inside 10 s is forced shut and the
  process exits `1`, which is still a shutdown this code chose rather than the
  platform's SIGKILL.
- **The pool has one owner.** `buildServer` builds it and the shutdown ends it.
  The stores are handed a pool and share it; none of them ends it. (They each
  used to expose `close()` calling `pool.end()` on that one shared pool, so
  closing any one of them ended the connections the other two still held.)

## Schema: creation and change

`createLibraryStore(pool).init()`, `createAuthStore(pool).init()` and
`createClipStore(pool).init()` (T063) all run
`CREATE TABLE IF NOT EXISTS` on every boot (`server/db.js`) — idempotent, so
a fresh database and one that already has the tables both end up in the same
state with no separate migration step to remember to run.

T071 added one table and one column this way, and both reach the
already-deployed database on its next restart with no manual step:

- `library_versions`, plus `CREATE INDEX IF NOT EXISTS
  library_versions_key_idx`, from `createLibraryStore(pool).init()`. No
  existing row is read or written.
- `clips.byte_size`, from `createClipStore(pool).init()` — the first change
  here to need the migration shape the next paragraph describes rather than
  a bare `CREATE TABLE`: `ALTER TABLE clips ADD COLUMN IF NOT EXISTS
  byte_size BIGINT` followed by `UPDATE clips SET byte_size =
  octet_length(bytes) WHERE byte_size IS NULL`. The backfill matches every
  pre-T071 row on the first boot and nothing on every boot after it.

**Verifying the SQL before it reaches her.** Every other server test runs
against `db.test.js`'s `fakePool`, which proves this code issues the SQL it
means to and proves nothing about whether Postgres accepts it — `app.test.js`
uses the same fake, so it is not independent evidence either. The dialect
(`ANY($1::bigint[])`, `octet_length`, `ADD COLUMN IF NOT EXISTS`, the
`byte_size` backfill) is verified by `server/db.postgres.test.js` against a
live server, including the real upgrade path: a `clips` table created without
`byte_size`, with rows already in it, then migrated. It is opt-in and skips
when unset, because an unavailable database is a missing environment, not a
broken change:

```sh
docker compose up -d postgres
# a scratch database this may DROP tables in — never the real one
SMOKE_DATABASE_URL=postgres://user:pass@host:5432/scratch npm test
```

Run it after any change to `server/db.js`'s SQL.

**How a future schema change is applied to a running deployment:** this
server has no migration runner (`node-pg-migrate`, `Flyway`, etc.) — adding
one is future work if `init()`'s `IF NOT EXISTS` approach stops being enough
(e.g. adding a column with a backfill, not just creating a table that isn't
there yet). Until then, a schema change ships as: (1) a migration SQL step
added to `init()` guarded by its own existence check (e.g. `ALTER TABLE ...
ADD COLUMN IF NOT EXISTS`), so it's still safe to run against both an old and
an already-migrated database, then (2) redeploy — Render (or `docker compose
up --build` locally) restarts the `phrase-drill` service, `init()` runs the guarded
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
the service's Logs tab in the Render dashboard) shows them as they happen. Every field is redacted
against both provider keys and the database password before the line is
written, so a raw secret can never appear even if a deeper error message
happened to contain one.
