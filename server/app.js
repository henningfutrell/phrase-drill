import { getBearerToken } from './auth.js'
import { computeClipHash, delimitedField } from './clip-hash.js'
import { planRequest } from './clip-job-store.js'
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
 * How long `/api/tts` waits on a queued generation before answering 202 (S5).
 * A phrase normally generates in one to three seconds, so nearly every miss
 * is still a single 200; the bound is under the provider's own 30 s timeout
 * and well under Safari's patience for a fetch. Past it the device is told
 * to ask again (`Retry-After`), and by then the clip is in the store.
 */
export const TTS_WAIT_MS = 25_000
/** The `Retry-After` on a 202, in seconds — the device's re-poll interval for a clip still being made. */
const TTS_QUEUED_RETRY_AFTER_S = 5

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
 * replayed body, a hand `curl` with her token — 409s every honest push from
 * both of her phones for good, and `sync-engine.ts:313-315` maps 409 to
 * `needs-update`, the one state that deliberately never retries. She is then
 * told to update an app for which no update exists, and her library has
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
 * to out-rank every honest push and 409 it forever. Reading it as 0 lets her
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
  clipJobStore,
  clipJobRunner,
  ttsWaitMs = TTS_WAIT_MS,
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
   * her library has stopped filling.
   */
  const ttsRequests = { total: 0, failed: 0 }

  /**
   * Cache lookups. Provider calls and billed failures are not kept here: the
   * calls are counted by the provider (`elevenLabs.stats()`), and whether a
   * call was billed is known only where its outcome is decided, the clip job
   * runner (`clipJobRunner.stats()`). Set against each other — misses far
   * above stored clips — they show the failure that cost a month (2026-09-02
   * to 2026-10-03) when `requests` alone read as healthy.
   */
  const clipLookups = { hits: 0, misses: 0 }
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

  /** Same rule for the queue's counts. */
  async function queueCountsOrNull() {
    try {
      return await clipJobStore.counts()
    } catch (err) {
      logger.warn('could not read clip queue counts', { message: describeError(err) })
      return null
    }
  }

  /** The one place a device asked for audio and did not get it. Kind and time only — never the text, the hash or the session. */
  function recordTtsFailure(kind) {
    ttsRequests.failed += 1
    lastTtsFailure = { kind, at: Date.now() }
  }

  /**
   * Whether a device is talking to this server at all, and when it last did.
   * `/api/library` is the route the sync engine touches at launch, after a
   * change, and on reconnect, so it is the one signal that separates "her
   * phone is on this build and something else is wrong" from "her phone is
   * not on this build" — the second is a live possibility while the old
   * Pages deploy, which has no server behind it, still answers.
   *
   * Aggregate, never per-device: there is one account, so a breakdown would
   * add nothing an operator can act on and would put her usage pattern on a
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
   * (T063), and otherwise generated by the clip job queue (S5) while this
   * request waits up to `ttsWaitMs` for it. docs/server.md "/api/tts — the
   * clip job queue" has the response contract.
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

    const request = await readClipRequest(req, res)
    if (!request) return
    const { fields, hash } = request

    // Counted from here, once the request is known to be a real ask for a
    // real clip: a malformed body or our own rate limit is not the provider
    // answering, and folding either in would make `/api/status`'s numbers
    // mean two things at once. A cache hit counts — it is a Clip her device
    // asked for and got.
    ttsRequests.total += 1

    const cached = await clipStore.get(hash)
    if (cached) {
      clipLookups.hits += 1
      return sendClip(res, cached)
    }
    clipLookups.misses += 1

    // A miss is a job (S5). `request` joins one already queued or running
    // for this hash — a re-poll, or a second device — rather than starting a
    // second paid generation, and refuses once the hash has cost its two
    // billed calls today.
    const requested = await clipJobStore.request(fields, Date.now())
    if (requested.capped) return sendBillingCapped(res)
    return answerWhenGenerated(res, hash)
  }

  /**
   * **Regenerate** (docs/glossary.md), the server half (R1): throw away the
   * Clip stored at this address and make it again. `/api/tts` serves a stored
   * Clip — broken or not — to every device forever, so without this a
   * truncated or garbled Clip could never be replaced. Same body, auth and
   * answers as `/api/tts` (`server-synth-client.ts` reads both with one
   * mapping); the device polls the ordinary `/api/tts` after a `202`.
   *
   * The order is the contract, and each step is where it is for a reason:
   *
   * 1. **The rate limiter, before anything else.** The device re-asks
   *    regenerate after a 429 — and only after a 429 — because a 429 means
   *    the server did nothing. That is only true if no delete or queue
   *    happens before the limiter says no.
   * 2. **A job already queued or running is joined, not restarted.** It is a
   *    generation in progress for this address; deleting again would remove
   *    nothing useful and, after it lands, would remove the new Clip.
   * 3. **The billing cap, before the delete.** A refused regenerate must not
   *    leave her with less audio than before: a capped hash keeps the Clip it
   *    has, broken or not, until its window reopens tomorrow. The check reads
   *    the row and writes nothing, so a refused regenerate does not mark a
   *    hash whose Clip is still stored as `failed`.
   * 4. **Delete, then queue.** In that order because `clipStore.put` is
   *    `ON CONFLICT DO NOTHING`: a job that finished while the old Clip was
   *    still stored would have its new bytes silently dropped. `request()`
   *    re-queues a `done` or `failed` row inside the cap — a regenerate is a
   *    miss the server made on purpose, so it is billed and counted like one.
   *
   * Between 3 and 4 another billed call could, in principle, reach the cap;
   * `request()` re-checks it under the row lock and the answer is then a
   * 422 with the Clip already gone. It needs a second billed generation of
   * the same phrase inside those milliseconds, and costs one regeneration
   * tomorrow, so it is named here rather than locked against.
   */
  async function handleTtsRegenerate(req, res, key) {
    const budget = ttsLimiter.allow(key)
    if (!budget.ok) return sendRateLimited(res, budget)

    const request = await readClipRequest(req, res)
    if (!request) return
    const { fields, hash } = request

    ttsRequests.total += 1
    clipLookups.misses += 1

    const now = Date.now()
    const job = await clipJobStore.get(hash)
    if (job?.state === 'queued' || job?.state === 'running') return answerWhenGenerated(res, hash)
    if (job && planRequest(job, now).capped) return sendBillingCapped(res)

    await clipStore.delete(hash)
    const requested = await clipJobStore.request(fields, now)
    if (requested.capped) return sendBillingCapped(res)
    return answerWhenGenerated(res, hash)
  }

  /**
   * The body of a `/api/tts` or `/api/tts/regenerate` request, validated, and
   * the content address derived from it — or `null` once the error is sent.
   * One function so the two routes cannot disagree about what a Clip request
   * is.
   */
  async function readClipRequest(req, res) {
    let body
    try {
      body = await readBody(req, { maxBytes: TTS_MAX_BODY_BYTES })
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        sendJson(res, 413, { error: 'payload-too-large' })
        return null
      }
      throw err
    }

    let parsed
    try {
      parsed = JSON.parse(body.toString('utf8'))
    } catch {
      sendJson(res, 400, { error: 'invalid-json' })
      return null
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
      lang.length === 0 ||
      // '|' is the address's delimiter; outside the text it would let two
      // requests share one Clip (S8a, `clip-hash.js`).
      delimitedField({ provider, modelId, voiceId, lang })
    ) {
      sendJson(res, 400, { error: 'invalid-request' })
      return null
    }

    const hash = computeClipHash({ provider, modelId, voiceId, lang, text })
    return { hash, fields: { hash, provider, modelId, voiceId, lang, text } }
  }

  function sendBillingCapped(res) {
    // Answered as `unreadable`: the device already treats that as terminal
    // (it is what a billed-but-unusable clip is), and it is true — this
    // phrase has produced nothing usable twice. Tomorrow it may try again.
    recordTtsFailure('billing-capped')
    logger.error('tts billing cap reached for a clip', { kind: 'billing-capped' })
    return sendJson(res, 422, { error: 'unreadable' })
  }

  /** Waits up to `ttsWaitMs` on the job for `hash` and answers what is known by then. */
  async function answerWhenGenerated(res, hash) {
    const outcome = clipJobRunner.waitFor(hash, ttsWaitMs)
    clipJobRunner.wake()
    const result = await outcome

    if (result.status === 'done') return sendClip(res, result.clip)
    if (result.status === 'pending') {
      // Still being made. Not a failure: the job runs on without this
      // request, and the device's next ask finds the clip in the store.
      return sendJson(res, 202, { status: 'queued' }, { 'retry-after': String(TTS_QUEUED_RETRY_AFTER_S) })
    }

    recordTtsFailure(result.kind)
    // A provider rate limit carries its own wait, and the device parks
    // exactly that long — so the header is the whole point of answering 429
    // rather than something terminal. `sendRateLimited` is this server's one
    // 429 shape, limiter or provider, so a client needs no second rule to read it.
    if (result.kind === 'rate-limited') return sendRateLimited(res, { retryAfterMs: result.retryAfterMs ?? 1000 })
    sendJson(res, statusForProviderError({ kind: result.kind }), { error: result.kind })
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
   * finding 2). Everything she wrote after that stayed on the phone.
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
   * and the intact library on her phone could never go back up.
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

    // Served byte for byte, not re-serialized: what she gets back is exactly
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
    // Her devices do not update together: one runs the bundle just
    // deployed, the other the bundle it last installed. An old client's
    // whole-library push is honest about what it knows and silent about
    // what it does not — it cannot carry a field its build has never heard
    // of. Letting it write would strip the newer envelope's merge metadata
    // (the Tombstones) off the server copy, and every Deck she deleted
    // would come back on the next sync.
    //
    // Refusing costs that device its sync until it updates — hours, and its
    // own changes stay safe on the device and go up afterwards. Accepting
    // costs her data. This is the one place both devices' pushes pass
    // through, so it is the only place the rule can be enforced for a
    // client that does not know the rule exists.
    const stored = await libraryStore.get(key)
    if (stored && parsed.schemaVersion < storedSchemaVersion(stored.data)) {
      return sendJson(res, 409, { error: 'stale-client' })
    }

    // Accepted, whatever it does to the size of her library — the server
    // cannot tell a client bug from her deleting a deck, and a refusal she
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
       * service and without her phone.
       *
       * **Unauthenticated, deliberately.** The operator has no session — the
       * only account is hers — so an authenticated status endpoint answers
       * only in the one situation where the answer is already available. What
       * it discloses is bounded to that decision: a coarse verdict, the
       * provider's own status word, two counters and two timestamps. No key,
       * no account figures, no user id, no phrase text, no hash, nothing that
       * distinguishes one device from another. It says "this deployment's
       * voice credential is being refused", which is a fact about our
       * operations, not about her.
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
            provider: { calls: elevenLabs.stats().attempts, billedFailures: clipJobRunner.stats().billedFailures },
            queue: await queueCountsOrNull(),
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
        // Her library is keyed by the session's user id (T050) — a stable,
        // server-issued identity, never a value the device could pick or a
        // pasted key someone else could hand out.
        const key = claims.sub

        if (url.pathname === '/api/tts' && req.method === 'POST') return await handleTts(req, res, key)
        if (url.pathname === '/api/tts/regenerate' && req.method === 'POST') return await handleTtsRegenerate(req, res, key)
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
    // 422 is terminal on the device. 'unreadable' is a billed body that was
    // not a usable clip; 'billed-failure' is a billed 2xx whose body failed
    // to read; 'rejected-request' is a 4xx for a request we built wrong, the
    // same answer every time; 'billing-capped' is a phrase that has cost its
    // two billed calls today (S5). A 502 for any of them was read by the
    // device as a network blip and asked again — and for the two billed
    // kinds that ask re-queued the job and paid a second time (R3).
    case 'unreadable':
    case 'billed-failure':
    case 'rejected-request':
    case 'billing-capped':
      return 422
    // A provider 5xx that survived the runner's three attempts, none of
    // them billed. 502 reaches the device as 'network', which it retries.
    case 'upstream':
      return 502
    default:
      return 502
  }
}

function describeError(err) {
  return err instanceof Error ? err.message : String(err)
}
