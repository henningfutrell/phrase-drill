import type { IDBPDatabase } from 'idb'
import { openDatabase, SETTINGS_STORE } from './database'

/** The pinned text-to-speech voice — provider, model, and voice id, together. */
export interface Voice {
  readonly provider: string
  readonly modelId: string
  readonly voiceId: string
}

/**
 * The pinned voice and small UI flags, as read from the `settings` store.
 * Never part of `Library` — `DeckStore.exportAll()` reads only the `decks`
 * store and structurally cannot see this data (see its own test).
 *
 * There is no identity field here (T043): the device's identity on the
 * server is a Keycloak access token, held by `keycloak-auth.ts` (in-memory
 * plus its own refresh-token storage), never generated or stored by this
 * module — the old device-generated 64-hex library key it replaces is
 * deleted, not deprecated.
 */
export interface Settings {
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
  load(): Promise<Settings>
  /** `null` clears the pinned voice. */
  setVoice(voice: Voice | null): Promise<void>
  /** One-way: there is no way back to `false` once dismissed. */
  dismissBackupNudge(): Promise<void>
  /** Records the epoch-ms time of a sync that just completed successfully,
   * replacing whatever was there before. */
  recordSync(timestamp: number): Promise<void>
}

const VOICE = 'voice'
const BACKUP_NUDGE_DISMISSED = 'backupNudgeDismissed'
const LAST_SYNC_AT = 'lastSyncAt'

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
      const [voice, backupNudgeDismissed, lastSyncAt] = await Promise.all([
        db.get(SETTINGS_STORE, VOICE) as Promise<Voice | undefined>,
        db.get(SETTINGS_STORE, BACKUP_NUDGE_DISMISSED) as Promise<boolean | undefined>,
        db.get(SETTINGS_STORE, LAST_SYNC_AT) as Promise<number | undefined>,
      ])
      return {
        voice: voice ?? null,
        backupNudgeDismissed: backupNudgeDismissed ?? false,
        lastSyncAt: lastSyncAt ?? null,
      }
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
