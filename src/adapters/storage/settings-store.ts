import type { Voice } from '../../domain'
import { createDatabaseConnection, SETTINGS_STORE } from './database'

/**
 * The pinned voice and small UI flags, as read from the `settings` store.
 * `DeckStore.exportAll()` reads only the `decks`, `mixes` and `tombstones`
 * stores and structurally cannot see this data (see its own test). Since
 * T067 exactly one field of it does travel — the pinned voice, joined onto
 * the `Library` envelope by name in `adapters/sync/synced-library.ts`, never
 * by exporting this record.
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
   * Epoch ms of the last Library sync the server ACCEPTED (`docs/sync.md`),
   * or `null` if none has ever completed. Written only by the sync engine, on
   * the success path and nowhere else, which is what makes it safe for the
   * sync line and Diagnostics (T039) to read it as proof a sync happened. It
   * is also half of the Backup age (`domain/backup-age`), which is why the
   * success-path-only rule matters twice over: a `lastSyncAt` written on a
   * failed push would silence the backup warning with nothing behind it.
   * Additive field: missing in previously-stored settings reads as `null`, so
   * existing data needs no migration.
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
  /**
   * Take the pinned voice carried by an arriving `Library` — a merge from
   * the server, or a backup file she restored (T067).
   *
   * `undefined` is a no-op, never a clear: an envelope written before T067
   * has no voice field, and reading its absence as "she has no voice" would
   * unpin the one on this phone. What to do when BOTH sides have one is
   * already settled by then — `mergeLibraries` decided it — so this just
   * writes what it is given.
   */
  adoptVoice(voice: Voice | undefined): Promise<void>
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
  // A handle is given up again both when the open is refused (T087) and when
  // the browser closes the connection (T077); `createDatabaseConnection` owns
  // why. What is at stake in this store is the pinned voice and `lastSyncAt` —
  // and `lastSyncAt` is half the Backup age, so a settings store stuck on a
  // handle it should have dropped is also a backup warning that can never be
  // quieted by a sync that really happened.
  const getDatabase = createDatabaseConnection()

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

    async adoptVoice(voice: Voice | undefined): Promise<void> {
      if (!voice) return
      await put(VOICE, voice)
    },

    recordSync(timestamp: number): Promise<void> {
      return put(LAST_SYNC_AT, timestamp)
    },

    recordExport(timestamp: number): Promise<void> {
      return put(LAST_EXPORT_AT, timestamp)
    },
  }
}
