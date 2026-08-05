import type { IDBPDatabase } from 'idb'
import type { Language, PhraseRecord, Voice } from '../../domain'
import { CLIPS_STORE, CLIP_META_STORE, createDatabaseConnection, runTransaction } from './database'

/**
 * A cached rendering of one side of one Phrase, in one voice — the on-disk
 * shape of the `clips` store (T019 §5.2, docs/glossary.md "Clip"). `bytes`
 * is an `ArrayBuffer`, not a `Blob`: Safari's IndexedDB `Blob` support has a
 * buggy history, so this is the conservative choice. Playback wraps it with
 * `URL.createObjectURL(new Blob([bytes]))`.
 */
export interface Clip {
  readonly hash: string
  readonly bytes: ArrayBuffer
  readonly mime: string
  readonly durationMs: number
  readonly createdAt: number
}

/**
 * Everything that determines the waveform, and therefore the content-address
 * (`hash`): provider, model, pinned voice, language, and the exact text.
 * Changing any one of these — an edited Phrase, a re-pinned voice — points
 * at a different hash, so the old Clip is simply orphaned rather than
 * requiring an explicit invalidation step.
 */
export interface ClipKey {
  readonly provider: string
  readonly modelId: string
  readonly voiceId: string
  readonly lang: Language
  readonly text: string
}

/** SHA-256 of `provider|modelId|voiceId|lang|text`, as lowercase hex. */
export async function computeClipHash(key: ClipKey): Promise<string> {
  const material = `${key.provider}|${key.modelId}|${key.voiceId}|${key.lang}|${key.text}`
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material))
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * The hash of the first of `voices` this cache holds a Clip for, or
 * `undefined` when none of them has one (T067).
 *
 * The one place the "which voice do we play?" rule lives, shared by the
 * readiness sweep and by playback so the two can never disagree: **the first
 * voice in the given order that has a Clip**, and callers put the pinned
 * voice first. Deterministic, and it stops at the first hit — a warm library
 * in the pinned voice costs one hash per side, exactly as before.
 *
 * Takes `has` rather than a whole cache because the cache implementation
 * calls it from inside itself, against its own in-memory index.
 */
export async function findCachedClipHash(
  has: (hash: string) => Promise<boolean>,
  voices: readonly Voice[],
  lang: Language,
  text: string,
): Promise<string | undefined> {
  for (const voice of voices) {
    const hash = await computeClipHash({ ...voice, lang, text })
    if (await has(hash)) return hash
  }
  return undefined
}

export interface ClipCache {
  /**
   * The cached Clip, if there is one — and the one call that counts as
   * *playing* it, so it is also what keeps a Clip alive under the bound
   * below.
   */
  get(hash: string): Promise<Clip | undefined>
  /** Insert or replace — a clip re-put under the same hash overwrites, never duplicates. */
  put(clip: Clip): Promise<void>
  has(hash: string): Promise<boolean>
  /**
   * Marks `hashes` as the current run's working set — spared from eviction
   * for as long as they hold that status (T016, the defect where a clip a
   * running drill still needs could be evicted mid-run: `has()` does not
   * count as play, so a Phrase the drill has not reached yet can carry a
   * stale `lastUsedAt` and lose to LRU while the drill that needs it runs).
   *
   * **Replaces the previous call's set; never adds to it.** One active
   * working set at a time, not a growing collection of every set ever
   * protected — the natural call site is `computeDrillReadiness`, which runs
   * once per drill start, so "the next drill starts" is the boundary that
   * retires the previous one. That is also what keeps this from leaking: it
   * is runtime-only (an in-memory `Set`, never persisted — see the
   * IndexedDB implementation's own note on why), so the worst case of a
   * drill that never starts another is one working set held for the rest of
   * the session, not an unbounded one.
   *
   * **Best-effort, not absolute.** A protected hash still loses to the
   * ceiling if evicting everything else was not enough — see the IndexedDB
   * implementation's `evictTo` for why that is the only safe choice.
   *
   * Optional: a `ClipCache` that never calls this is simply unprotected, the
   * behaviour every caller had before this method existed.
   */
  protect?(hashes: Iterable<string>): void
  /**
   * Which of these Phrases already have both an FR and an EN clip cached in
   * ANY of `voices` — "can be drilled right now, without generating
   * anything". One call over the whole set, the question the drill-start
   * readiness sweep asks, not one `has` per Phrase per language.
   *
   * **A list of voices, not the pinned one (T067).** A Clip's voice is a
   * property of that Clip: audio made in one voice stays playable after
   * another is pinned, so asking only about the pinned voice reported a
   * fully-generated library as entirely unready and queued all of it for
   * regeneration. `voices` is in preference order — pinned first — and the
   * first hit wins, so the ordinary case (everything in the pinned voice)
   * costs exactly what it did before.
   */
  readyPhraseIds(phrases: readonly PhraseRecord[], voices: readonly Voice[]): Promise<Set<string>>
}

/** What the cache is holding, and what it is allowed to hold (T036). */
export interface ClipCacheUsage {
  readonly bytes: number
  readonly clipCount: number
  readonly maxBytes: number
}

/**
 * A `ClipCache` that also states what it is holding. Separate from the port
 * above because only two callers ask — the composition root, to show her, and
 * a test, to check the ceiling held. Everything that plays or generates audio
 * (`clip-player.ts`, `generation-queue.ts`, `drill-readiness.ts`) wants the
 * plain read/write port and would be made to fake a method it never calls.
 */
export interface BoundedClipCache extends ClipCache {
  usage(): Promise<ClipCacheUsage>
}

/**
 * The ceiling, in bytes: **200 MB**.
 *
 * Chosen against three measured/modelled numbers, not picked round:
 *
 * - A Clip is ~89 KB per Phrase-pair (docs/scale.md §1), so 200 MB is about
 *   2,250 Phrases — roughly 45 Decks of 50 — resident at once. She drills one
 *   Deck repeatedly and then moves to the next, so the working set that has
 *   to survive is one Deck (~4.4 MB), or a Mix of several. 200 MB holds every
 *   Deck she has touched in months, not merely the current one.
 * - It is under a quarter of a ~1 GB iOS origin allowance, which keeps this
 *   app off the top of the list when the phone is looking for something to
 *   evict. The failure this exists to prevent is Safari discarding the whole
 *   origin under storage pressure, and that risk scales with how fat the
 *   origin looks, not with whether we were within our rights.
 * - It is ~23% of the 848 MB a full 10,000-Phrase library would model to, so
 *   the bound genuinely binds at her real library size rather than being a
 *   ceiling nothing ever reaches.
 *
 * Evicting became nearly free in T063: a re-fetch after eviction usually
 * costs a Postgres read from the shared server-side clip store, not an
 * ElevenLabs generation. That is what makes a ceiling this tight the right
 * trade — the cost of being wrong is one network round-trip, and the cost of
 * having no ceiling is her library.
 */
export const DEFAULT_CLIP_CACHE_MAX_BYTES = 200 * 1024 * 1024

/**
 * How far under the ceiling one eviction sweep goes. Evicting exactly to the
 * ceiling would make the *next* put sweep again, and every put after that —
 * a sort and a delete per Clip for the whole rest of a cold fill. Ten percent
 * of headroom amortizes the sweep over ~450 Clips.
 */
const EVICT_TO_FRACTION = 0.9

/**
 * How many Clips the index backfill reads before writing their rows and
 * letting them go (T072). At ~89 KB a Clip (docs/scale.md §1) this is about
 * 2 MB in hand at once — bounded by a constant instead of by the size of her
 * cache, which is the whole point. Reading one at a time would bound it
 * tighter and cost a round-trip per Clip over ~10,000 of them; a chunk trades
 * two megabytes for that.
 */
export const CLIP_META_BACKFILL_CHUNK = 25

export interface ClipCacheOptions {
  /** Defaults to `DEFAULT_CLIP_CACHE_MAX_BYTES`. */
  readonly maxBytes?: number
  /** Injectable so eviction order is testable without wall-clock ties. */
  readonly now?: () => number
}

/**
 * The origin is full. Read off `name` rather than `instanceof DOMException`:
 * the storage layer is faked in tests at the `idb` seam, and a check only a
 * real browser can satisfy is a check the tests cannot run.
 */
function isQuotaExceeded(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'QuotaExceededError'
}

/** One row of the `clipMeta` store — the size index, never the audio. */
interface ClipMeta {
  readonly hash: string
  readonly bytes: number
  readonly lastUsedAt: number
}

/**
 * The IndexedDB implementation of `ClipCache`, via `idb`. Shares the one
 * database `indexed-db-deck-store.ts` and `settings-store.ts` open
 * (`database.ts`), but touches only the `clips` and `clipMeta` stores — never
 * `decks`, `mixes`, `settings` or `tombstones` — so a cached clip can never
 * ride along on `DeckStore.exportAll()`. Clips are derived cache, not user
 * data (T019 §5.1); there is nothing to redact because `exportAll` never
 * reads this store.
 *
 * **Bounded, and it evicts (T036).** Without a bound the cache grows
 * monotonically — ~890 MB at 10,000 Phrases (docs/scale.md §1) — and on iOS an
 * origin that fat is one the browser may discard *whole*, taking the Phrases
 * with it. That asymmetry decides everything here: a Clip is derived and
 * regenerable, a Phrase is not, so this throws Clips away readily and can
 * reach nothing else. Eviction is structural, not promised: the only two
 * store names it can name are `CLIPS_STORE` and `CLIP_META_STORE`.
 *
 * **Least recently played**, and `get()` is the only thing that counts as
 * playing. She drills one Deck repeatedly, then moves to another; LRU on
 * playback keeps the Deck in hand resident and lets the Deck she left behind
 * go first, which is exactly the shape of her use. Oldest-first (by
 * `createdAt`) would evict the Deck she has drilled daily since the day she
 * made it. `has()` deliberately does not count: it is the readiness sweep's
 * question, asked of every Phrase in the library at every drill start, so
 * counting it would reset every Clip's age at once and leave the policy with
 * nothing to order by.
 */
export function createIndexedDbClipCache(options: ClipCacheOptions = {}): BoundedClipCache {
  const maxBytes = options.maxBytes ?? DEFAULT_CLIP_CACHE_MAX_BYTES
  const now = options.now ?? Date.now
  // Insertion order is LRU order, oldest first — every touch re-inserts, so
  // the first key is always the least recently played.
  let indexPromise: Promise<Map<string, ClipMeta>> | undefined
  let totalBytes = 0
  /**
   * The current run's working set (T016) — see `protect()`'s doc comment on
   * the port for the lifecycle. Never persisted: it describes what a run in
   * *this* session needs, and a fresh session has no run in progress yet.
   */
  let protectedHashes = new Set<string>()

  /**
   * The open database handle, opened once — **and given up again both when
   * the open fails (T085) and when the browser closes the connection (T077).**
   * `createDatabaseConnection` owns why. What this store loses by holding a
   * handle it should have dropped is silence: audio is derived and can always
   * be made again, but not until something opens the database.
   */
  const getDatabase = createDatabaseConnection()

  /**
   * The size index, read once per cache instance. Small rows only — the whole
   * reason `clipMeta` is its own store is that this never loads audio.
   *
   * The index is **reconciled against the audio** before it is used (T076),
   * and then the ceiling is applied to it (T076) — in that order, because
   * evicting against a wrong account is worse than not evicting at all.
   *
   * Blocking, not background: an index that under-reports the cache says "not
   * ready" for Phrases that are ready, which queues audio for regeneration
   * that is already on the disk.
   */
  function getIndex(): Promise<Map<string, ClipMeta>> {
    indexPromise ??= buildIndex().catch((error: unknown) => {
      // Forgotten on failure, for the same reason `getDatabase` forgets a
      // failed open (T085): a half-built index that rejected once must not be
      // the answer every screen gets for the rest of the session.
      indexPromise = undefined
      throw error
    })
    return indexPromise
  }

  async function buildIndex(): Promise<Map<string, ClipMeta>> {
    const db = await getDatabase()
    const rows = await reconcileIndex(db, (await db.getAll(CLIP_META_STORE)) as ClipMeta[])
    const index = new Map<string, ClipMeta>()
    totalBytes = 0
    for (const row of [...rows].sort((a, b) => a.lastUsedAt - b.lastUsedAt)) {
      index.set(row.hash, row)
      totalBytes += row.bytes
    }
    // The ceiling applies on every launch, not only when she generates
    // something (T076). Nothing to protect here — no Clip was just cached.
    await evictDownToTarget(index, undefined)
    return index
  }

  /**
   * The index made to agree with the audio, in both directions — the rows that
   * survive, returned.
   *
   * Every number the ceiling is enforced against is computed from this index,
   * so an index that disagrees with the `clips` store is a ceiling that does
   * not bind. The two drift apart in both directions:
   *
   * - **A Clip with no row (T072).** The v5 -> v6 backfill: the store was
   *   created empty, so a phone that upgraded into this build has audio nobody
   *   has measured. Left alone it reads as no audio at all and the whole
   *   library is re-fetched.
   * - **A row with no Clip (T076).** That row is charged against the ceiling
   *   forever, and `has()` answers `true` for audio that is gone. This code's
   *   own eviction no longer makes them — it removes both in one transaction
   *   (T078, `evictTo`) — but healing stays: a phone that has been running the
   *   two-step version carries rows it orphaned, and the browser dropping
   *   records out of this origin on its own is a source nothing here can close.
   *
   * The second also hides the first: this used to ask `count(CLIPS_STORE) <=
   * known.length` and stop there, so one orphan cancelled one unindexed Clip
   * exactly, and that Clip was never indexed on any launch, ever. Hence keys,
   * not a count. `getAllKeys` over the `clips` store is ~10,000 hex hashes at a
   * full library — about 1 MB of strings, no structured clone of an
   * `ArrayBuffer` (docs/scale.md §3) — paid once per launch. That is the price
   * of an account that is true, and a count is not a cheaper version of it, it
   * is a wrong one.
   *
   * `clipMeta` is **derived**, exactly like the audio it measures: a row whose
   * Clip is gone describes nothing, so deleting it loses nothing. Nothing here
   * can name a store but `CLIPS_STORE` and `CLIP_META_STORE`, and only ever
   * deletes from the latter — a Clip is only ever *added* to the index.
   *
   * Still bounded and still resumable (T072): audio is read one
   * `CLIP_META_BACKFILL_CHUNK` at a time and only the byte count is kept, and
   * the work is driven off the difference between the two stores, so an
   * interrupted run leaves the rows it managed and the next launch does the
   * rest. `lastUsedAt` seeds from `createdAt`: nothing recorded when a Clip was
   * last played before this store existed, and generation order is the only
   * honest answer available.
   */
  async function reconcileIndex(db: IDBPDatabase, known: readonly ClipMeta[]): Promise<ClipMeta[]> {
    const cached = new Set((await db.getAllKeys(CLIPS_STORE)) as string[])

    const live: ClipMeta[] = []
    for (const row of known) {
      if (cached.has(row.hash)) {
        live.push(row)
        continue
      }
      await db.delete(CLIP_META_STORE, row.hash)
    }

    const indexed = new Set(live.map((row) => row.hash))
    const missing = [...cached].filter((hash) => !indexed.has(hash))

    for (let from = 0; from < missing.length; from += CLIP_META_BACKFILL_CHUNK) {
      const chunk = missing.slice(from, from + CLIP_META_BACKFILL_CHUNK)
      const clips = (await Promise.all(chunk.map((hash) => db.get(CLIPS_STORE, hash)))) as (Clip | undefined)[]
      for (const clip of clips) {
        if (!clip) continue
        const meta: ClipMeta = { hash: clip.hash, bytes: clip.bytes.byteLength, lastUsedAt: clip.createdAt }
        await db.put(CLIP_META_STORE, meta)
        live.push(meta)
      }
    }
    return live
  }

  /**
   * The two rows of one cached Clip, written — and written again once, after
   * making room, when the device says it is full (T085).
   *
   * A `QuotaExceededError` is the origin being full, not this cache being
   * over its own ceiling, so `evictDownToTarget` does not fire: `totalBytes`
   * can sit far under `maxBytes` while the phone has no room at all. Left
   * there, the first refusal is also the last successful generation of the
   * session — every later Clip is refused the same way and she drills in
   * silence until the storage frees itself.
   *
   * Dropping a tenth of the cache is the right answer to that, and not only
   * for the audio: the origin this cache shares is the one her Decks are
   * written to, so clip bytes given back are bytes the next Phrase can be
   * saved into. Clips are derived and regenerable — a re-fetch after eviction
   * is usually one Postgres read (T063) — and a Phrase is not, so this trades
   * the cheap thing for the irreplaceable one every time.
   *
   * One retry, not a loop. If room was made and the device still refuses, the
   * refusal is not about our bytes, and evicting her whole cache to keep
   * asking would be paying an unbounded price for a fixed answer. The throw
   * reaches `put`'s caller with the index untouched.
   */
  async function writeClip(
    db: IDBPDatabase,
    index: Map<string, ClipMeta>,
    clip: Clip,
    meta: ClipMeta,
  ): Promise<void> {
    try {
      await db.put(CLIPS_STORE, clip)
      await db.put(CLIP_META_STORE, meta)
    } catch (error) {
      if (!isQuotaExceeded(error)) throw error
      await evictTo(index, Math.floor(totalBytes * EVICT_TO_FRACTION), clip.hash)
      await db.put(CLIPS_STORE, clip)
      await db.put(CLIP_META_STORE, meta)
    }
  }

  /** Re-dates a Clip and moves it to the young end of the LRU order. */
  async function touch(hash: string, index: Map<string, ClipMeta>): Promise<void> {
    const existing = index.get(hash)
    if (!existing) return
    const updated: ClipMeta = { ...existing, lastUsedAt: now() }
    index.delete(hash)
    index.set(hash, updated)
    const db = await getDatabase()
    await db.put(CLIP_META_STORE, updated)
  }

  /**
   * Deletes least-recently-played Clips until the cache is back under
   * `EVICT_TO_FRACTION` of the ceiling. `protectedHash` is the Clip a put just
   * cached — evicting it would mean a put that silently did nothing, and the
   * caller has no way to notice — or `undefined` on the launch sweep, where
   * nothing was just cached and everything is a candidate.
   *
   * **The index is a parameter, not something this fetches (T076).** The
   * launch sweep runs from inside `getIndex`'s own build, and by then
   * `indexPromise` is already assigned — the assignment happens when the async
   * body reaches its first `await`, not when it returns. So a `getIndex()`
   * here would await the very promise this work has to settle: a hang with no
   * timeout, on the index every screen waits for. Verified, not assumed.
   */
  async function evictDownToTarget(index: Map<string, ClipMeta>, protectedHash: string | undefined): Promise<void> {
    if (totalBytes <= maxBytes) return
    await evictTo(index, Math.floor(maxBytes * EVICT_TO_FRACTION), protectedHash)
  }

  /**
   * Least-recently-played first, until the cache holds no more than `target`
   * bytes — **and each Clip leaves in ONE transaction (T078).**
   *
   * The audio and its index row used to go as two transactions, and that gap
   * is where the orphaned rows T076 heals were made: interrupted between them
   * — the app backgrounded, the tab killed — the row outlives the Clip it
   * describes, `has()` answers `true` for audio that is gone, and she drills a
   * Phrase that plays nothing until the next launch reconciles. One
   * transaction over both stores removes the gap rather than surviving it.
   *
   * **T076's healing stays regardless.** A phone carrying rows orphaned by the
   * old two-step eviction still needs them cleaned up on launch, and a Clip
   * the browser evicts on its own (iOS reclaiming the origin's storage) is a
   * source this code cannot close at all.
   *
   * One transaction per Clip, not one for the whole sweep. What must be
   * indivisible is one Clip's removal; a sweep that holds both stores for
   * ~450 evictions blocks every read she is waiting on, and an interruption
   * mid-sweep would then roll back work that was correct and complete. Per
   * Clip, an interrupted sweep leaves a consistent smaller cache and the next
   * one carries on.
   *
   * **Two passes, because `protectedHashes` (T016) is best-effort, not a
   * guarantee.** Pass one skips the running drill's working set exactly as it
   * skips `protectedHash`; pass two drops that exemption and evicts from it
   * too, oldest first, same as everything else. A Mix broad enough to make
   * the working set alone exceed `target` would otherwise leave `put()`
   * unable to make room — deadlocked against its own ceiling, or forced to
   * throw and drop her audio outright. Losing the least-recently-played
   * member of the set she is mid-drill on is the worse of two bad options,
   * but the alternative is worse still: a cache that stops accepting new
   * audio, silently, for the rest of the session.
   */
  async function evictTo(
    index: Map<string, ClipMeta>,
    target: number,
    protectedHash: string | undefined,
  ): Promise<void> {
    if (totalBytes <= target) return
    const db = await getDatabase()

    async function evictOne(hash: string, meta: ClipMeta): Promise<void> {
      const tx = db.transaction([CLIPS_STORE, CLIP_META_STORE], 'readwrite')
      await runTransaction(tx, async () => {
        await tx.objectStore(CLIPS_STORE).delete(hash)
        await tx.objectStore(CLIP_META_STORE).delete(hash)
      })
      index.delete(hash)
      totalBytes -= meta.bytes
    }

    // Pass 1: everything except the just-written clip and the working set.
    for (const hash of [...index.keys()]) {
      if (totalBytes <= target) return
      if (hash === protectedHash || protectedHashes.has(hash)) continue
      const meta = index.get(hash)
      if (!meta) continue
      await evictOne(hash, meta)
    }

    // Pass 2: the working set gives way too — never the just-written clip.
    for (const hash of [...index.keys()]) {
      if (totalBytes <= target) return
      if (hash === protectedHash) continue
      const meta = index.get(hash)
      if (!meta) continue
      await evictOne(hash, meta)
    }
  }

  return {
    async get(hash: string): Promise<Clip | undefined> {
      const db = await getDatabase()
      const clip = (await db.get(CLIPS_STORE, hash)) as Clip | undefined
      if (clip) {
        try {
          await touch(hash, await getIndex())
        } catch {
          // The audio is in hand and she is waiting to hear it. A refused
          // write of the play-time row changes which Clip is evicted next —
          // it must not turn a Clip that was read into silence (T085).
        }
      }
      return clip
    },

    async put(clip: Clip): Promise<void> {
      const db = await getDatabase()
      const index = await getIndex()
      const meta: ClipMeta = { hash: clip.hash, bytes: clip.bytes.byteLength, lastUsedAt: now() }

      // **Written first, counted second (T085).** The index is what `has()`
      // and the readiness sweep answer from, so counting a Clip the device
      // then refused reports a Phrase as drillable that plays nothing and is
      // never queued for regeneration: silence with nothing trying to fix it.
      // A throw here leaves the index describing exactly what is on the disk.
      await writeClip(db, index, clip, meta)

      const previous = index.get(clip.hash)
      if (previous) totalBytes -= previous.bytes
      totalBytes += meta.bytes
      index.delete(clip.hash)
      index.set(clip.hash, meta)

      await evictDownToTarget(index, clip.hash)
    },

    protect(hashes: Iterable<string>): void {
      // Replaces, never merges — see the port's doc comment for why an
      // accumulating set is the leak that eventually defeats this entirely.
      protectedHashes = new Set(hashes)
    },

    async has(hash: string): Promise<boolean> {
      // Answered from the index, not the audio: this is the readiness sweep's
      // question, and reading the Clip to answer it deserializes an
      // ArrayBuffer nobody is going to play.
      //
      // **Still deliberately not a touch (T016).** `protect()` is a more
      // precise fix than refreshing `lastUsedAt` here would have been:
      // refreshing on `has()` would reset the age of every Phrase in the
      // WHOLE library on every readiness sweep — including the thousands she
      // has no intention of drilling today — degrading LRU back toward
      // "evict whatever is oldest by wall-clock generation time" exactly as
      // the original doc comment on the class warns. `protect()` marks only
      // the Phrases this run will actually use, which is narrower and correct
      // where a blanket touch-on-read would only have been narrower.
      return (await getIndex()).has(hash)
    },

    async readyPhraseIds(phrases: readonly PhraseRecord[], voices: readonly Voice[]): Promise<Set<string>> {
      if (phrases.length === 0) return new Set()

      // The index, not `getAll(CLIPS_STORE)`. The old form loaded every Clip
      // in the cache — the whole ~848 MB at a full library — to answer a
      // question about which hashes exist (docs/scale.md §3). Asking about
      // several voices does not change that: this is still one read of the
      // small `clipMeta` rows, already in memory, and the extra work is
      // hashing, which touches no storage at all.
      const cachedHashes = await getIndex()
      const has = (hash: string): Promise<boolean> => Promise.resolve(cachedHashes.has(hash))

      const ready = new Set<string>()
      for (const phrase of phrases) {
        const [french, english] = await Promise.all([
          findCachedClipHash(has, voices, 'fr-FR', phrase.french),
          findCachedClipHash(has, voices, 'en-US', phrase.english),
        ])
        if (french && english) {
          ready.add(phrase.id)
        }
      }
      return ready
    },

    async usage(): Promise<ClipCacheUsage> {
      const index = await getIndex()
      return { bytes: totalBytes, clipCount: index.size, maxBytes }
    },
  }
}
