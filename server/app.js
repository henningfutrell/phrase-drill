import { getBearerToken } from './auth.js'
import { computeClipHash } from './clip-hash.js'
import { validateClip } from './clip-validation.js'
import { readBody, sendJson, PayloadTooLargeError } from './http-helpers.js'
import { createStaticHandler } from './static.js'

const TTS_MAX_BODY_BYTES = 8_000 // a phrase is a sentence, not a document
const TTS_MAX_TEXT_CHARS = 2_000
const SCAN_MAX_BODY_BYTES = 6 * 1024 * 1024 // one downsized photo (device caps ~1600px/JPEG q0.85)
const LIBRARY_MAX_BODY_BYTES = 8 * 1024 * 1024 // ~6.5x the modelled 10,000-phrase export (docs/scale.md §4)
const LOGIN_MAX_BODY_BYTES = 2_000 // a username and password, not a document
const TRANSLATE_MAX_BODY_BYTES = 4_000 // one phrase plus a deck name, not a document
const TRANSLATE_MAX_TEXT_CHARS = 500
const LIBRARY_FORMAT = 'phrase-drill-library'

/**
 * How long a credential probe's verdict is served before another is taken.
 *
 * Five minutes: long enough that polling `/api/status` cannot become a bill,
 * short enough that a key rotated or a wallet topped up shows as fixed inside
 * one coffee. A probe is a paid call (`elevenlabs-client.js` `probe()`), so
 * this number is a cost decision, not a caching nicety.
 */
const PROBE_TTL_MS = 5 * 60 * 1000

/**
 * The highest `schemaVersion` this build will accept in a push (T082).
 *
 * **Keep this equal to `src/adapters/storage/migrations.ts`'s
 * `CURRENT_SCHEMA_VERSION`.** The server and the PWA it serves are one Render
 * service and one build, so no device can ever hold a bundle newer than this
 * process — an older cached bundle pushing a lower version is the only skew
 * that exists, and the T060 gate below is what handles that.
 * `server/library-envelope.test.js` fails if a schema bump forgets this line.
 *
 * **Why an upper bound at all.** `schemaVersion` gates every push (the T060
 * stale-client 409). Unbounded, one stored rogue value — a buggy build, a
 * replayed body, a hand `curl` with their token — 409s every honest push from
 * both of their phones for good, and `sync-engine.ts:313-315` maps 409 to
 * `needs-update`, the one state that deliberately never retries. The user is then
 * told to update an app for which no update exists, and their library has
 * already been overwritten by the push that did it.
 */
export const LIBRARY_MAX_SCHEMA_VERSION = 6

/**
 * Whether a `schemaVersion` is one this server can store, serve and compare.
 *
 * The set `typeof value === 'number'` admits is wider than that: `1e999` is
 * legal JSON, parses to `Infinity`, and `JSON.stringify` writes it back as
 * `null`. That is the whole of audit finding 2 — validate the parsed value,
 * store a re-serialization of it, and the two are not the same value. The
 * bound is applied here, on the way in, and the row is stored as the bytes
 * that were checked (see `handleLibraryPut`), so neither half can drift again.
 */
function isAcceptableSchemaVersion(value) {
  return Number.isInteger(value) && value >= 1 && value <= LIBRARY_MAX_SCHEMA_VERSION
}

/**
 * The one way this server refuses a request for being too fast (T035).
 *
 * It answers 429 with `Retry-After`, and it is the *only* thing here that
 * answers 429: a provider running out of credits answers 402 (see
 * `statusForProviderError`). Those two used to share a status, which made
 * them indistinguishable at the device — and the device, unable to tell "wait
 * a moment" from "this will never succeed", gave up on both. A cold library
 * sweep lost ~1,940 of 2,000 Clips to that, to our own limiter.
 *
 * `Retry-After` in seconds is RFC 9110's field, understood by anything
 * between here and the device, and it carries the number the client cannot
 * derive: how full the bucket is. Rounded up, and never below one second —
 * a `Retry-After: 0` is an invitation to hammer.
 */
function sendRateLimited(res, decision) {
  const seconds = Math.max(1, Math.ceil(decision.retryAfterMs / 1000))
  return sendJson(res, 429, { error: 'rate-limited' }, { 'retry-after': String(seconds) })
}

/**
 * Whether a parsed body is a library envelope at all. The same shape test is
 * applied to what a client sends and to what the server reads back out of its
 * own row (T071) — a row that fails it is not a library, whoever wrote it.
 */
function isLibraryEnvelope(value) {
  return (
    !!value &&
    typeof value === 'object' &&
    value.format === LIBRARY_FORMAT &&
    typeof value.schemaVersion === 'number' &&
    Array.isArray(value.decks) &&
    (value.mixes === undefined || Array.isArray(value.mixes)) &&
    (value.tombstones === undefined || Array.isArray(value.tombstones)) &&
    // The pinned voice (T067): an object or nothing. Absent is every
    // envelope written before T067 and means "no voice recorded". The
    // server stores the envelope verbatim and never reads inside this
    // field, so a shallow check is all it owes — the device validates the
    // three parts of the content address itself (`domain/voice.ts`).
    (value.voice === undefined ||
      (typeof value.voice === 'object' && value.voice !== null && !Array.isArray(value.voice)))
  )
}

/**
 * The schema version of a stored envelope, read back out of the JSON the
 * server keeps opaque otherwise. `0` for anything unreadable, missing a
 * numeric version, *or carrying one outside the range this build accepts* —
 * the permissive answer, so a corrupt, ancient or rogue stored row can never
 * lock a client out of syncing.
 *
 * The out-of-range clause is the repair path for a row an already-deployed
 * server may be holding right now (T082): a stored `999` or `Infinity` used
 * to out-rank every honest push and 409 it forever. Reading it as 0 lets them
 * phone's next push through, and that push archives the bad bytes on the way
 * past. No migration script, no `psql`.
 */
function storedSchemaVersion(data) {
  try {
    const version = JSON.parse(data).schemaVersion
    return isAcceptableSchemaVersion(version) ? version : 0
  } catch {
    return 0
  }
}

/**
 * Builds the one request handler this server runs — every `/api/*` route
 * plus the static PWA fallback. Pure composition: every dependency (the
 * providers, the rate limiters, the library store, the logger) is injected,
 * so this module never itself imports `node:sqlite` or `fetch` and is
 * exercised in tests with fakes for all of them.
 */
export function createApp({
  libraryStore,
  clipStore,
  elevenLabs,
  anthropic,
  ttsLimiter,
  scanLimiter,
  libraryLimiter,
  loginLimiter,
  translateLimiter,
  distDir,
  logger,
  sessionAuth,
}) {
  const serveStatic = createStaticHandler(distDir)

  /**
   * What `/api/status` reports about `/api/tts`, kept in this process and
   * nowhere else. In-memory on purpose: it is an operational reading, not a
   * record, and the alternative is a table nobody prunes for a number that is
   * only interesting while the process that took it is alive. A deploy resets
   * it, which is honest — after a deploy nothing is known yet.
   *
   * `failed` counts every answer that was not a clip, and `lastFailure`
   * carries the provider's kind and when it happened. No user id, no phrase
   * text, no hash: a count and a kind are all an operator needs to know that
   * their library has stopped filling.
   */
  const ttsRequests = { total: 0, failed: 0 }

  /**
   * Cache lookups, and the 2xx responses ElevenLabs billed for that produced
   * no stored clip. `provider.calls` is not kept here: only the provider
   * sees its own retries (`elevenLabs.stats()`). Set against each other —
   * misses far above stored clips — they show the failure that cost a month
   * (2026-09-02 to 2026-10-03) when `requests` alone read as healthy.
   */
  const clipLookups = { hits: 0, misses: 0 }
  let billedFailures = 0
  let lastTtsFailure

  /** A status read must not fail because the store's SUM did: report null instead. */
  async function storeBytesOrNull() {
    try {
      return await clipStore.totalBytes()
    } catch (err) {
      logger.warn('could not read clip store size', { message: describeError(err) })
      return null
    }
  }

  /**
   * Whether a device is talking to this server at all, and when it last did.
   * `/api/library` is the route the sync engine touches at launch, after a
   * change, and on reconnect, so it is the one signal that separates "them
   * phone is on this build and something else is wrong" from "their phone is
   * not on this build" — the second is a live possibility while the old
   * Pages deploy, which has no server behind it, still answers.
   *
   * Aggregate, never per-device: there is one account, so a breakdown would
   * add nothing an operator can act on and would put their usage pattern on a
   * public endpoint.
   */
  const libraryCalls = { reads: 0, writes: 0 }
  let lastLibraryAt

  /** The cached credential probe — see `probeCredential`. */
  let credentialProbe
  let credentialProbeInFlight

  /**
   * The provider probe, taken at most once per `PROBE_TTL_MS` and never
   * concurrently.
   *
   * Both bounds exist because a probe is a real, paid synthesis call: without
   * the TTL anything polling this endpoint spends the credit it is reporting
   * on, and without the in-flight latch a burst of callers on a cold process
   * each start their own.
   */
  async function probeCredential() {
    const now = Date.now()
    if (credentialProbe && now - credentialProbe.checkedAt < PROBE_TTL_MS) return credentialProbe
    if (credentialProbeInFlight) return credentialProbeInFlight

    credentialProbeInFlight = (async () => {
      try {
        const result = await elevenLabs.probe()
        credentialProbe = { ...result, checkedAt: Date.now() }
      } catch (err) {
        // A probe that throws is still an answer about reachability, and it
        // must never become a 500 on the one endpoint an operator reaches for
        // when something is already broken.
        credentialProbe = {
          configured: true,
          credential: 'unreachable',
          detail: describeError(err),
          checkedAt: Date.now(),
        }
      } finally {
        credentialProbeInFlight = undefined
      }
      return credentialProbe
    })()

    return credentialProbeInFlight
  }

  async function handleLogin(req, res) {
    let body
    try {
      body = await readBody(req, { maxBytes: LOGIN_MAX_BODY_BYTES })
    } catch (err) {
      if (err instanceof PayloadTooLargeError) return sendJson(res, 413, { error: 'payload-too-large' })
      throw err
    }

    let parsed
    try {
      parsed = JSON.parse(body.toString('utf8'))
    } catch {
      return sendJson(res, 400, { error: 'invalid-json' })
    }

    const { username, password } = parsed ?? {}
    if (typeof username !== 'string' || username.length === 0 || typeof password !== 'string' || password.length === 0) {
      return sendJson(res, 400, { error: 'invalid-request' })
    }

    // Rate-limited hard, keyed by username — 5 attempts per 60s
    // (buildServer wires the limiter's capacity/refillMs) — before
    // credentials are ever checked, so a brute force against one username
    // never even reaches the scrypt comparison after the fifth try.
    const loginBudget = loginLimiter.allow(username)
    if (!loginBudget.ok) return sendRateLimited(res, loginBudget)

    // Never pass the password to the logger, in a field or a message — see
    // docs/server.md "Provable: no key can leak".
    const result = await sessionAuth.login(username, password)
    if (!result) return sendJson(res, 401, { error: 'invalid-credentials' })
    sendJson(res, 200, { token: result.token, expiresAt: result.expiresAt })
  }

  async function handleLogout(req, res) {
    const token = getBearerToken(req)
    if (token) await sessionAuth.logout(token)
    res.writeHead(204)
    res.end()
  }

  /**
   * Speech for one phrase, served from the shared Clip store when it can be
   * (T063).
   *
   * **The rate limiter stays in front, and a cache hit spends a token.** The
   * tempting alternative — free hits, since a hit costs no provider money —
   * puts an un-metered path behind a bearer token: a stolen one (docs/server.md
   * lists that in the threat model) could then pull audio out of Postgres as
   * fast as the process would serve it. A hit is still an authenticated
   * request doing a database read and streaming ~20 KB back, so it is still
   * work worth bounding. Note what this does *not* fix: a device sweeping a
   * whole library still hits the 60/60s ceiling on the second device exactly
   * as it did on the first. It gets there without spending money now, which
   * is a smaller bill, not a working sweep.
   */
  async function handleTts(req, res, key) {
    const budget = ttsLimiter.allow(key)
    if (!budget.ok) return sendRateLimited(res, budget)

    let body
    try {
      body = await readBody(req, { maxBytes: TTS_MAX_BODY_BYTES })
    } catch (err) {
      if (err instanceof PayloadTooLargeError) return sendJson(res, 413, { error: 'payload-too-large' })
      throw err
    }

    let parsed
    try {
      parsed = JSON.parse(body.toString('utf8'))
    } catch {
      return sendJson(res, 400, { error: 'invalid-json' })
    }

    // `provider` and `lang` are required even though the ElevenLabs call uses
    // neither: they are two of the five fields the Clip's content address is
    // derived from, and an address missing a field is a different address
    // from the one the device holds. Required outright, with no default
    // invented for a caller that omits them — a guessed `provider` would
    // silently key the shared store against a value nobody chose.
    const { text, voiceId, modelId, provider, lang } = parsed ?? {}
    if (
      typeof text !== 'string' ||
      text.length === 0 ||
      text.length > TTS_MAX_TEXT_CHARS ||
      typeof voiceId !== 'string' ||
      voiceId.length === 0 ||
      typeof modelId !== 'string' ||
      modelId.length === 0 ||
      typeof provider !== 'string' ||
      provider.length === 0 ||
      typeof lang !== 'string' ||
      lang.length === 0
    ) {
      return sendJson(res, 400, { error: 'invalid-request' })
    }

    const hash = computeClipHash({ provider, modelId, voiceId, lang, text })

    // Counted from here, once the request is known to be a real ask for a
    // real clip: a malformed body or our own rate limit is not the provider
    // answering, and folding either in would make `/api/status`'s numbers
    // mean two things at once. A cache hit counts — it is a Clip their device
    // asked for and got.
    ttsRequests.total += 1

    const cached = await clipStore.get(hash)
    if (cached) {
      clipLookups.hits += 1
      return sendClip(res, cached)
    }
    clipLookups.misses += 1

    try {
      const result = await elevenLabs.synthesize({ text, voiceId, modelId })
      const invalid = validateClip({ bytes: result.bytes, contentType: result.contentType, text })
      if (invalid) {
        // Thrown, not just logged: it must reach the outer catch below so
        // this response is neither cached (the `clipStore.put` a few lines
        // down never runs) nor served as if it were complete. Never retried
        // either — the provider already billed for this body.
        throw providerLikeError('unreadable', `ElevenLabs returned an unusable clip: ${invalid}`)
      }
      const clip = { bytes: result.bytes, mime: 'audio/mpeg', durationMs: result.durationMs }
      // A failed write must not fail the request: these bytes have already
      // been generated and paid for, and the caller wants the audio far more
      // than it wants the store to be complete. The next request for this
      // phrase pays again — the cost of a store outage, not of a bug.
      try {
        await clipStore.put({ hash, ...clip, createdAt: Date.now() })
      } catch (err) {
        logger.warn('could not store generated clip', { hash, message: describeError(err) })
      }
      sendClip(res, clip)
    } catch (err) {
      // The one place that knows a device asked for audio and did not get
      // it. Kind and time only — never the text, the hash or the session.
      ttsRequests.failed += 1
      // Both kinds are a 2xx the provider billed that yielded no clip.
      if (err.kind === 'billed-failure' || err.kind === 'unreadable') billedFailures += 1
      lastTtsFailure = { kind: err.kind ?? 'network', at: Date.now() }
      logger.error('tts provider error', { kind: lastTtsFailure.kind, message: describeError(err) })
      // A provider rate limit carries its own wait, and the device parks
      // exactly that long — so the header is the whole point of answering
      // 429 rather than something terminal. `sendRateLimited` is this
      // server's one 429 shape, limiter or provider, so a client needs no
      // second rule to read it.
      if (err.kind === 'rate-limited') {
        return sendRateLimited(res, { retryAfterMs: err.retryAfterMs ?? 1000 })
      }
      sendJson(res, statusForProviderError(err), { error: err.kind ?? 'network' })
    }
  }

  async function handleScan(req, res, key) {
    const budget = scanLimiter.allow(key)
    if (!budget.ok) return sendRateLimited(res, budget)

    let body
    try {
      body = await readBody(req, { maxBytes: SCAN_MAX_BODY_BYTES })
    } catch (err) {
      if (err instanceof PayloadTooLargeError) return sendJson(res, 413, { error: 'payload-too-large' })
      throw err
    }
    if (body.length === 0) return sendJson(res, 400, { error: 'invalid-request' })

    const contentType = req.headers['content-type']
    const mediaType = typeof contentType === 'string' && contentType.startsWith('image/') ? contentType : 'image/jpeg'

    try {
      const phrases = await anthropic.scan({ base64: body.toString('base64'), mediaType })
      sendJson(res, 200, { phrases })
    } catch (err) {
      sendJson(res, statusForProviderError(err), { error: err.kind ?? 'network' })
    }
  }

  async function handleTranslate(req, res, key) {
    const budget = translateLimiter.allow(key)
    if (!budget.ok) return sendRateLimited(res, budget)

    let body
    try {
      body = await readBody(req, { maxBytes: TRANSLATE_MAX_BODY_BYTES })
    } catch (err) {
      if (err instanceof PayloadTooLargeError) return sendJson(res, 413, { error: 'payload-too-large' })
      throw err
    }

    let parsed
    try {
      parsed = JSON.parse(body.toString('utf8'))
    } catch {
      return sendJson(res, 400, { error: 'invalid-json' })
    }

    const { text, direction, deckName } = parsed ?? {}
    if (
      typeof text !== 'string' ||
      text.length === 0 ||
      text.length > TRANSLATE_MAX_TEXT_CHARS ||
      (direction !== 'en-to-fr' && direction !== 'fr-to-en') ||
      typeof deckName !== 'string'
    ) {
      return sendJson(res, 400, { error: 'invalid-request' })
    }

    try {
      const candidates = await anthropic.translate({ text, direction, deckName })
      sendJson(res, 200, { candidates })
    } catch (err) {
      sendJson(res, statusForProviderError(err), { error: err.kind ?? 'network' })
    }
  }

  /**
   * The stored row, validated before it is served (T071).
   *
   * This used to be `res.end(row.data)` with no check at all. A row that will
   * not parse — hand-repaired, half-restored, truncated by anything upstream
   * — came back as a 200 that claimed to be a library, the device called
   * `response.json()` on it, that threw, and the sync engine died for the
   * rest of the session while the UI still said "syncing" (AUDIT-T068
   * finding 2). Everything the user wrote after that stayed on the phone.
   *
   * 500 is the honest status: the fault is this server's, not the request's.
   * It is also a *handled* result at the device rather than an exception
   * nothing catches.
   *
   * **The status AND this body are a contract (T089).** This is the only
   * thing this server says that is a verdict on its own stored bytes rather
   * than on the request, and the device reads it as exactly that: a pull that
   * returns it is the one pull failure after which the phone is allowed to
   * push (`src/adapters/sync/library-sync-client.ts` →
   * `server-copy-unreadable`). That is what makes a poisoned row repairable
   * rather than permanent — the PUT path below was already open, and until
   * T089 nothing walked through it, because a pull that failed skips the push
   * and the intact library on their phone could never go back up.
   *
   * So `library-unreadable` is load-bearing, and asserted on both sides of
   * the boundary. Answering 404 here instead was refused in T082 and upheld
   * in T089: 404 means "no server copy", the device already has a meaning for
   * it, and conflating the two throws away the loud signal. A generic 500
   * (`server-error`) is not this and must not be read as this — a server that
   * fell over says nothing about the row it holds.
   *
   * The row is not repaired, deleted or overwritten here. It is the last copy
   * of something, even when what it is is unreadable; a PUT may still replace
   * it (`storedSchemaVersion` answers 0 for it, deliberately), and that PUT
   * archives these bytes on the way past.
   */
  async function handleLibraryGet(req, res, key) {
    const budget = libraryLimiter.allow(key)
    if (!budget.ok) return sendRateLimited(res, budget)
    // Counted before the row is looked at: a 404 (no library stored yet) is
    // still a device that reached this server, which is the whole question
    // these two numbers answer.
    libraryCalls.reads += 1
    lastLibraryAt = Date.now()
    const row = await libraryStore.get(key)
    if (!row) return sendJson(res, 404, { error: 'not-found' })

    let parsed
    try {
      parsed = JSON.parse(row.data)
    } catch {
      parsed = null
    }
    if (!isLibraryEnvelope(parsed)) {
      logger.error('stored library is unreadable and was not served', { key, bytes: Buffer.byteLength(row.data), updatedAt: row.updatedAt })
      return sendJson(res, 500, { error: 'library-unreadable' })
    }

    // Served byte for byte, not re-serialized: what the user gets back is exactly
    // what was stored, so nothing this server does can quietly reshape it.
    // True of the write path too since T082 — `handleLibraryPut` stores the
    // request's own bytes, so the round trip is byte for byte end to end.
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(row.data)
  }

  async function handleLibraryPut(req, res, key) {
    const budget = libraryLimiter.allow(key)
    if (!budget.ok) return sendRateLimited(res, budget)
    libraryCalls.writes += 1
    lastLibraryAt = Date.now()

    let body
    try {
      body = await readBody(req, { maxBytes: LIBRARY_MAX_BODY_BYTES })
    } catch (err) {
      if (err instanceof PayloadTooLargeError) return sendJson(res, 413, { error: 'payload-too-large' })
      throw err
    }

    // The exact bytes that will be stored, if this request is accepted. What
    // is validated below and what is written must be the same value — the
    // old path validated `parsed` and stored `JSON.stringify(parsed)`, and a
    // `schemaVersion` of `1e999` is the demonstration that those differ
    // (T082, audit finding 2).
    const raw = body.toString('utf8')

    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      return sendJson(res, 400, { error: 'invalid-json' })
    }
    if (!isLibraryEnvelope(parsed)) return sendJson(res, 400, { error: 'invalid-request' })

    // Bounded, and an integer (T082). Note this is NOT folded into
    // `isLibraryEnvelope`: that test also runs on the way out, and a row
    // written before this bound existed must still be *served*, not turned
    // into a 500. Refuse on the way in; stay permissive on the way out.
    if (!isAcceptableSchemaVersion(parsed.schemaVersion)) return sendJson(res, 400, { error: 'invalid-request' })

    // A client older than the stored envelope may not overwrite it (T060).
    //
    // Their devices do not update together: one runs the bundle just
    // deployed, the other the bundle it last installed. An old client's
    // whole-library push is honest about what it knows and silent about
    // what it does not — it cannot carry a field its build has never heard
    // of. Letting it write would strip the newer envelope's merge metadata
    // (the Tombstones) off the server copy, and every Deck the user deleted
    // would come back on the next sync.
    //
    // Refusing costs that device its sync until it updates — hours, and its
    // own changes stay safe on the device and go up afterwards. Accepting
    // costs their data. This is the one place both devices' pushes pass
    // through, so it is the only place the rule can be enforced for a
    // client that does not know the rule exists.
    const stored = await libraryStore.get(key)
    if (stored && parsed.schemaVersion < storedSchemaVersion(stored.data)) {
      return sendJson(res, 409, { error: 'stale-client' })
    }

    // Accepted, whatever it does to the size of their library — the server
    // cannot tell a client bug from their deleting a deck, and a refusal the user
    // cannot get past is its own failure. What makes a bad push survivable is
    // that `libraryStore.put` archives the version it replaces (T071); it is
    // the store's invariant, not a step this route can forget.
    //
    // Stored as the bytes that were validated, not as a re-serialization of
    // them (T082). GET already promised "byte for byte, not re-serialized";
    // that was true of the read path and false of the write path, and the gap
    // between the two is where a value could change between being checked and
    // being written. Both paths keep the client's bytes now, so the promise
    // holds end to end and this server reshapes nothing it is given.
    await libraryStore.put(key, raw, Date.now())
    res.writeHead(204)
    res.end()
  }

  return async function handleRequest(req, res) {
    const started = Date.now()
    try {
      const url = new URL(req.url, 'http://internal')

      if (url.pathname === '/api/health') {
        sendJson(res, 200, { status: 'ok' })
        return
      }

      /**
       * Why audio is not being made, readable by anyone who can reach this
       * service and without their phone.
       *
       * **Unauthenticated, deliberately.** The operator has no session — the
       * only account is theirs — so an authenticated status endpoint answers
       * only in the one situation where the answer is already available. What
       * it discloses is bounded to that decision: a coarse verdict, the
       * provider's own status word, two counters and two timestamps. No key,
       * no account figures, no user id, no phrase text, no hash, nothing that
       * distinguishes one device from another. It says "this deployment's
       * voice credential is being refused", which is a fact about our
       * operations, not about them.
       *
       * `/api/health` stays exactly `{"status":"ok"}` — it is the platform's
       * liveness probe, it must not depend on a third party, and it must not
       * pay for a synthesis call to answer.
       */
      if (url.pathname === '/api/status') {
        const probe = await probeCredential()
        sendJson(res, 200, {
          tts: {
            configured: probe.configured,
            credential: probe.credential,
            detail: probe.detail,
            checkedAt: probe.checkedAt,
            requests: { total: ttsRequests.total, failed: ttsRequests.failed },
            clips: { ...clipLookups, storeBytes: await storeBytesOrNull() },
            provider: { calls: elevenLabs.stats().attempts, billedFailures },
            ...(lastTtsFailure ? { lastFailure: lastTtsFailure } : {}),
          },
          library: {
            reads: libraryCalls.reads,
            writes: libraryCalls.writes,
            ...(lastLibraryAt ? { lastAt: lastLibraryAt } : {}),
          },
        })
        return
      }

      if (url.pathname === '/api/login' && req.method === 'POST') return await handleLogin(req, res)
      if (url.pathname === '/api/logout' && req.method === 'POST') return await handleLogout(req, res)

      if (url.pathname.startsWith('/api/')) {
        const token = getBearerToken(req)
        let claims = null
        if (token) {
          try {
            claims = await sessionAuth.verify(token)
          } catch {
            claims = null
          }
        }
        if (!claims || typeof claims.sub !== 'string' || claims.sub.length === 0) {
          sendJson(res, 401, { error: 'unauthorized' })
          return
        }
        // Their library is keyed by the session's user id (T050) — a stable,
        // server-issued identity, never a value the device could pick or a
        // pasted key someone else could hand out.
        const key = claims.sub

        if (url.pathname === '/api/tts' && req.method === 'POST') return await handleTts(req, res, key)
        if (url.pathname === '/api/scan' && req.method === 'POST') return await handleScan(req, res, key)
        if (url.pathname === '/api/translate' && req.method === 'POST') return await handleTranslate(req, res, key)
        if (url.pathname === '/api/library' && req.method === 'GET') return await handleLibraryGet(req, res, key)
        if (url.pathname === '/api/library' && req.method === 'PUT') return await handleLibraryPut(req, res, key)

        sendJson(res, 404, { error: 'not-found' })
        return
      }

      await serveStatic(req, res, url.pathname)
    } catch (err) {
      logger.error('unhandled request error', { message: describeError(err) })
      if (!res.headersSent) sendJson(res, 500, { error: 'server-error' })
    } finally {
      logger.info('request', {
        method: req.method,
        path: req.url,
        status: res.statusCode,
        ms: Date.now() - started,
      })
    }
  }
}

/** One response shape for a Clip, whether it came from the store or the provider — the caller cannot tell, and must not have to. */
function sendClip(res, clip) {
  res.writeHead(200, {
    'content-type': clip.mime,
    'content-length': clip.bytes.byteLength,
    'x-duration-ms': String(clip.durationMs),
  })
  res.end(clip.bytes)
}

function statusForProviderError(err) {
  switch (err.kind) {
    case 'not-configured':
      return 503
    // 402 for a bill, 429 for a wait (T035, corrected 2026-09-02). A 429
    // from here used to mean one thing only — this server's own limiter —
    // and the provider's 429 was folded into `quota`/402, which the device
    // treats as terminal. Both statuses now mean exactly what they say to
    // the device: 429 is "ask again in `Retry-After`", from either limiter,
    // and 402 is "somebody must pay", which no wait fixes.
    case 'rate-limited':
      return 429
    case 'quota':
      return 402
    case 'unreadable':
      return 422
    // Both reach the device as 502, which it treats as 'network'. 'upstream'
    // is a provider 5xx (retried server-side already); 'billed-failure' is a
    // 2xx whose body failed to read — billed, never retried server-side.
    case 'upstream':
    case 'billed-failure':
      return 502
    default:
      return 502
  }
}

function describeError(err) {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Builds an error with the same `.kind` shape the provider clients throw
 * (`server/providers/*.js`), so a defect caught here — the short-clip floor
 * above — is reported through the same `statusForProviderError` path as a
 * defect the provider itself detected, rather than inventing a second one.
 */
function providerLikeError(kind, message) {
  const err = new Error(message)
  err.kind = kind
  return err
}
