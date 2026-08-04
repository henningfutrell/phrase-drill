import type { IDBPDatabase } from 'idb'
import type { Language, PhraseRecord, Voice } from '../../domain'
import { CLIPS_STORE, CLIP_META_STORE, openDatabase } from './database'

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

export interface ClipCacheOptions {
  /** Defaults to `DEFAULT_CLIP_CACHE_MAX_BYTES`. */
  readonly maxBytes?: number
  /** Injectable so eviction order is testable without wall-clock ties. */
  readonly now?: () => number
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
  let dbPromise: Promise<IDBPDatabase> | undefined
  // Insertion order is LRU order, oldest first — every touch re-inserts, so
  // the first key is always the least recently played.
  let indexPromise: Promise<Map<string, ClipMeta>> | undefined
  let totalBytes = 0

  function getDatabase(): Promise<IDBPDatabase> {
    dbPromise ??= openDatabase()
    return dbPromise
  }

  /**
   * The size index, read once per cache instance. Small rows only — the whole
   * reason `clipMeta` is its own store is that this never loads audio.
   */
  function getIndex(): Promise<Map<string, ClipMeta>> {
    indexPromise ??= (async () => {
      const db = await getDatabase()
      const rows = (await db.getAll(CLIP_META_STORE)) as ClipMeta[]
      rows.sort((a, b) => a.lastUsedAt - b.lastUsedAt)
      const index = new Map<string, ClipMeta>()
      for (const row of rows) {
        index.set(row.hash, row)
        totalBytes += row.bytes
      }
      return index
    })()
    return indexPromise
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
   * `EVICT_TO_FRACTION` of the ceiling. `protectedHash` is the Clip this put
   * just cached: evicting it would mean a put that silently did nothing, and
   * the caller has no way to notice.
   */
  async function evictDownToTarget(protectedHash: string): Promise<void> {
    if (totalBytes <= maxBytes) return
    const db = await getDatabase()
    const index = await getIndex()
    const target = Math.floor(maxBytes * EVICT_TO_FRACTION)

    for (const hash of [...index.keys()]) {
      if (totalBytes <= target) break
      if (hash === protectedHash) continue
      const meta = index.get(hash)
      if (!meta) continue
      await db.delete(CLIPS_STORE, hash)
      await db.delete(CLIP_META_STORE, hash)
      index.delete(hash)
      totalBytes -= meta.bytes
    }
  }

  return {
    async get(hash: string): Promise<Clip | undefined> {
      const db = await getDatabase()
      const clip = (await db.get(CLIPS_STORE, hash)) as Clip | undefined
      if (clip) await touch(hash, await getIndex())
      return clip
    },

    async put(clip: Clip): Promise<void> {
      const db = await getDatabase()
      const index = await getIndex()

      const meta: ClipMeta = { hash: clip.hash, bytes: clip.bytes.byteLength, lastUsedAt: now() }
      const previous = index.get(clip.hash)
      if (previous) totalBytes -= previous.bytes
      totalBytes += meta.bytes
      index.delete(clip.hash)
      index.set(clip.hash, meta)

      await db.put(CLIPS_STORE, clip)
      await db.put(CLIP_META_STORE, meta)

      await evictDownToTarget(clip.hash)
    },

    async has(hash: string): Promise<boolean> {
      // Answered from the index, not the audio: this is the readiness sweep's
      // question, and reading the Clip to answer it deserializes an
      // ArrayBuffer nobody is going to play.
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
