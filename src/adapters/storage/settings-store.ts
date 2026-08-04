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
 * There is no identity field here (T043, T050): the device's identity on
 * the server is an opaque session token, held by `session-auth.ts` in
 * `localStorage`, never generated or stored by this module — the old
 * device-generated 64-hex library key it replaces is deleted, not
 * deprecated.
 */
export interface Settings {
  readonly voice: Voice | null
  /**
   * Epoch ms of the last successful Library push to the server, or `null` if
   * none has ever completed. Half of the Backup age (`domain/backup-age`);
   * Diagnostics (T039) also reads it. Additive field: missing in
   * previously-stored settings reads as `null`, so existing data needs no
   * migration.
   */
  readonly lastSyncAt: number | null
  /**
   * Epoch ms of the last backup file she exported herself, or `null` if she
   * never has. The other half of the Backup age. Kept separate from
   * `lastSyncAt` rather than folded into one "last backup" number, because
   * they fail independently — an age driven only by exports would stay loud
   * while sync worked perfectly, and one driven only by sync would go quiet
   * for a file she never actually saved.
   *
   * The retired `backupNudgeDismissed` flag (T027) is gone, deleted rather
   * than deprecated: the nudge it silenced no longer exists. An old value
   * left in the `settings` store by a previous build is simply never read.
   * Nothing of hers is at stake in that — this store holds UI flags and the
   * pinned voice, never drill data.
   */
  readonly lastExportAt: number | null
}

export interface SettingsStore {
  load(): Promise<Settings>
  /** `null` clears the pinned voice. */
  setVoice(voice: Voice | null): Promise<void>
  /** Records the epoch-ms time of a sync that just completed successfully,
   * replacing whatever was there before. */
  recordSync(timestamp: number): Promise<void>
  /** Records the epoch-ms time of a backup file that actually left the app,
   * replacing whatever was there before. A cancelled share is not one. */
  recordExport(timestamp: number): Promise<void>
}

const VOICE = 'voice'
const LAST_SYNC_AT = 'lastSyncAt'
const LAST_EXPORT_AT = 'lastExportAt'

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
      const [voice, lastSyncAt, lastExportAt] = await Promise.all([
        db.get(SETTINGS_STORE, VOICE) as Promise<Voice | undefined>,
        db.get(SETTINGS_STORE, LAST_SYNC_AT) as Promise<number | undefined>,
        db.get(SETTINGS_STORE, LAST_EXPORT_AT) as Promise<number | undefined>,
      ])
      return {
        voice: voice ?? null,
        lastSyncAt: lastSyncAt ?? null,
        lastExportAt: lastExportAt ?? null,
      }
    },

    setVoice(voice: Voice | null): Promise<void> {
      return put(VOICE, voice)
    },

    recordSync(timestamp: number): Promise<void> {
      return put(LAST_SYNC_AT, timestamp)
    },

    recordExport(timestamp: number): Promise<void> {
      return put(LAST_EXPORT_AT, timestamp)
    },
  }
}
