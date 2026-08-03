import type { IDBPDatabase } from 'idb'
import { openDatabase, SETTINGS_STORE } from './database'

/** The pinned text-to-speech voice — provider, model, and voice id, together. */
export interface Voice {
  readonly provider: string
  readonly modelId: string
  readonly voiceId: string
}

/**
 * The library key and the pinned voice, as read from the `settings` store.
 * Never part of `Library` — `DeckStore.exportAll()` reads only the `decks`
 * store and structurally cannot see this data (see its own test).
 */
export interface Settings {
  /**
   * The device's identity on the server (T041): 64 lowercase hex characters,
   * 256 bits of entropy, generated on first `load()` if none is stored yet.
   * Never a provider API key — the server holds those, not the device. Not
   * masked or secret in the UI the way the old provider keys were: showing
   * and copying it is the whole recovery story for a wiped or replaced
   * phone, so `SettingsScreen` displays it in the open, deliberately.
   */
  readonly libraryKey: string
  readonly voice: Voice | null
  /**
   * The first-run backup nudge (docs/design.md §3.6, T027), dismissed once
   * and for good — shown on the Decks empty state and after the first
   * successful Scan until she dismisses it from either place. Additive field:
   * missing in previously-stored settings reads as `false` (never dismissed),
   * so existing data needs no migration.
   */
  readonly backupNudgeDismissed: boolean
  /**
   * Epoch ms of the last successful Library sync (`docs/sync.md`), or `null`
   * if none has ever completed. Diagnostics (T039) is the first reader;
   * nothing writes this yet — the sync feature that calls `recordSync` is a
   * separate change. Additive field: missing in previously-stored settings
   * reads as `null`, same treatment as `backupNudgeDismissed`.
   */
  readonly lastSyncAt: number | null
}

export interface SettingsStore {
  /** Generates and persists a library key on first call if none exists yet. */
  load(): Promise<Settings>
  /**
   * Switches this device to a different library key — "use a different key"
   * in Settings, the recovery path for a wiped/replacement phone that still
   * has the old key written down. Overwrites whatever key was stored, if any.
   */
  setLibraryKey(key: string): Promise<void>
  /** `null` clears the pinned voice. */
  setVoice(voice: Voice | null): Promise<void>
  /** One-way: there is no way back to `false` once dismissed. */
  dismissBackupNudge(): Promise<void>
  /** Records the epoch-ms time of a sync that just completed successfully,
   * replacing whatever was there before. */
  recordSync(timestamp: number): Promise<void>
}

const LIBRARY_KEY = 'libraryKey'
const VOICE = 'voice'
const BACKUP_NUDGE_DISMISSED = 'backupNudgeDismissed'
const LAST_SYNC_AT = 'lastSyncAt'

/** 32 random bytes, hex-encoded — 256 bits of entropy, 64 lowercase hex characters. */
function generateLibraryKey(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * The IndexedDB implementation of `SettingsStore`, via `idb`. Shares the one
 * database `indexed-db-deck-store.ts` opens (`database.ts`), but touches
 * only the `settings` store — never `decks` — so a key or the pinned voice
 * can never ride along on a Deck read or write.
 */
export function createIndexedDbSettingsStore(): SettingsStore {
  let dbPromise: Promise<IDBPDatabase> | undefined

  function getDatabase(): Promise<IDBPDatabase> {
    dbPromise ??= openDatabase()
    return dbPromise
  }

  async function put(key: string, value: unknown): Promise<void> {
    const db = await getDatabase()
    if (value === null || value === undefined) {
      await db.delete(SETTINGS_STORE, key)
    } else {
      await db.put(SETTINGS_STORE, value, key)
    }
  }

  return {
    async load(): Promise<Settings> {
      const db = await getDatabase()
      const [storedLibraryKey, voice, backupNudgeDismissed, lastSyncAt] = await Promise.all([
        db.get(SETTINGS_STORE, LIBRARY_KEY) as Promise<string | undefined>,
        db.get(SETTINGS_STORE, VOICE) as Promise<Voice | undefined>,
        db.get(SETTINGS_STORE, BACKUP_NUDGE_DISMISSED) as Promise<boolean | undefined>,
        db.get(SETTINGS_STORE, LAST_SYNC_AT) as Promise<number | undefined>,
      ])
      let libraryKey = storedLibraryKey
      if (libraryKey === undefined) {
        libraryKey = generateLibraryKey()
        await put(LIBRARY_KEY, libraryKey)
      }
      return {
        libraryKey,
        voice: voice ?? null,
        backupNudgeDismissed: backupNudgeDismissed ?? false,
        lastSyncAt: lastSyncAt ?? null,
      }
    },

    setLibraryKey(key: string): Promise<void> {
      return put(LIBRARY_KEY, key)
    },

    setVoice(voice: Voice | null): Promise<void> {
      return put(VOICE, voice)
    },

    dismissBackupNudge(): Promise<void> {
      return put(BACKUP_NUDGE_DISMISSED, true)
    },

    recordSync(timestamp: number): Promise<void> {
      return put(LAST_SYNC_AT, timestamp)
    },
  }
}
