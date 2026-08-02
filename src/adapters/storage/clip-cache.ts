import type { IDBPDatabase } from 'idb'
import type { Language, PhraseRecord } from '../../domain'
import { CLIPS_STORE, openDatabase } from './database'
import type { Voice } from './settings-store'

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

export interface ClipCache {
  get(hash: string): Promise<Clip | undefined>
  /** Insert or replace — a clip re-put under the same hash overwrites, never duplicates. */
  put(clip: Clip): Promise<void>
  has(hash: string): Promise<boolean>
  /**
   * Which of these Phrases already have both an FR and an EN clip cached
   * under the given (pinned) voice — "can be drilled right now, without
   * generating anything". One call over the whole set, the question the
   * drill-start readiness sweep asks, not one `has` per Phrase per language.
   */
  readyPhraseIds(phrases: readonly PhraseRecord[], voice: Voice): Promise<Set<string>>
}

/**
 * The IndexedDB implementation of `ClipCache`, via `idb`. Shares the one
 * database `indexed-db-deck-store.ts` and `settings-store.ts` open
 * (`database.ts`), but touches only the `clips` store — never `decks` — so
 * a cached clip can never ride along on `DeckStore.exportAll()`. Clips are
 * derived cache, not user data (T019 §5.1); there is nothing to redact
 * because `exportAll` never reads this store.
 */
export function createIndexedDbClipCache(): ClipCache {
  let dbPromise: Promise<IDBPDatabase> | undefined

  function getDatabase(): Promise<IDBPDatabase> {
    dbPromise ??= openDatabase()
    return dbPromise
  }

  return {
    async get(hash: string): Promise<Clip | undefined> {
      const db = await getDatabase()
      return (await db.get(CLIPS_STORE, hash)) as Clip | undefined
    },

    async put(clip: Clip): Promise<void> {
      const db = await getDatabase()
      await db.put(CLIPS_STORE, clip)
    },

    async has(hash: string): Promise<boolean> {
      const db = await getDatabase()
      return (await db.get(CLIPS_STORE, hash)) !== undefined
    },

    async readyPhraseIds(phrases: readonly PhraseRecord[], voice: Voice): Promise<Set<string>> {
      if (phrases.length === 0) return new Set()

      const db = await getDatabase()
      const clips = (await db.getAll(CLIPS_STORE)) as Clip[]
      const cachedHashes = new Set(clips.map((clip) => clip.hash))

      const ready = new Set<string>()
      for (const phrase of phrases) {
        const [frHash, enHash] = await Promise.all([
          computeClipHash({ ...voice, lang: 'fr-FR', text: phrase.french }),
          computeClipHash({ ...voice, lang: 'en-US', text: phrase.english }),
        ])
        if (cachedHashes.has(frHash) && cachedHashes.has(enHash)) {
          ready.add(phrase.id)
        }
      }
      return ready
    },
  }
}
