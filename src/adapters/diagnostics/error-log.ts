import type { IDBPDatabase } from 'idb'
import { openDatabase, ERRORS_STORE } from '../storage/database'
import { redactSecrets } from './redact'

/** One captured error, as stored and as shown in a diagnostic report. */
export interface LogEntry {
  readonly id: number
  readonly timestamp: number
  readonly source: string
  readonly message: string
}

/** What `record()` takes — `id` is assigned by the store, not the caller. */
export type NewLogEntry = Omit<LogEntry, 'id'>

export interface ErrorLog {
  record(entry: NewLogEntry): Promise<void>
  /** Oldest to newest. */
  list(): Promise<readonly LogEntry[]>
}

/**
 * Bounded ring buffer cap. 50 is enough recent history to diagnose "it's not
 * working" (the last few minutes of use, typically a handful of failures,
 * not hundreds) while staying cheap: `record()` reads the whole store to
 * find the next id and trim (see below), and the fake `idb` test double this
 * app already relies on has no cursor/count, so keeping the store small is
 * what keeps that `getAll()` cheap too. This is the one error-capture store,
 * separate from the unbounded clip cache flagged in `docs/scale.md` — this
 * one is capped from day one so it never becomes a second unbounded store.
 */
export const ERROR_LOG_CAP = 50

export interface ErrorLogDeps {
  /** Live API keys to redact out of a message before it is ever persisted —
   * called on every `record()` so a key entered after the log was created
   * is still caught. Typically `() => settingsStore.load().then(s =>
   * [s.anthropicApiKey, s.elevenLabsApiKey])`. */
  getSecrets(): Promise<readonly (string | null | undefined)[]>
}

/**
 * IndexedDB-backed `ErrorLog`, sharing the app's one database (`database.ts`)
 * via the `errors` store. Redaction happens here — the single write path —
 * so nothing that calls `record()` can bypass it (AGENTS.md "Never leak
 * secrets"). The fake `idb` test double has no `autoIncrement`, so ids are
 * computed as `max(existing) + 1`; cheap because the store never exceeds
 * `ERROR_LOG_CAP`.
 */
export function createIndexedDbErrorLog({ getSecrets }: ErrorLogDeps): ErrorLog {
  let dbPromise: Promise<IDBPDatabase> | undefined

  function getDatabase(): Promise<IDBPDatabase> {
    dbPromise ??= openDatabase()
    return dbPromise
  }

  return {
    async record(entry: NewLogEntry): Promise<void> {
      const db = await getDatabase()
      const secrets = await getSecrets()
      const message = redactSecrets(entry.message, secrets)

      const existing = ((await db.getAll(ERRORS_STORE)) as LogEntry[]).sort((a, b) => a.id - b.id)
      const nextId = existing.length === 0 ? 1 : existing[existing.length - 1]!.id + 1
      const newEntry: LogEntry = { id: nextId, timestamp: entry.timestamp, source: entry.source, message }

      // Trim oldest-first so the store never grows past ERROR_LOG_CAP.
      const overflow = existing.length + 1 - ERROR_LOG_CAP
      const toDrop = overflow > 0 ? existing.slice(0, overflow) : []

      for (const dropped of toDrop) await db.delete(ERRORS_STORE, dropped.id)
      await db.put(ERRORS_STORE, newEntry)
    },

    async list(): Promise<readonly LogEntry[]> {
      const db = await getDatabase()
      const entries = (await db.getAll(ERRORS_STORE)) as LogEntry[]
      return entries.sort((a, b) => a.id - b.id)
    },
  }
}
