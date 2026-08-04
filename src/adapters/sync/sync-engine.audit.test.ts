import { describe, expect, it } from 'vitest'
import { LIBRARY_FORMAT, mergeLibraries, type DeckRecord, type Library } from '../../domain'
import { normalizeLibrary } from '../storage/library'
import { sameLibraryContent, sameVoice } from '../storage/library-identity'
import { CURRENT_SCHEMA_VERSION } from '../storage/migrations'
import { createSyncEngine, type PlatformPort, type Scheduler, type SyncEngine } from './sync-engine'

/**
 * T080 audit of T070 (the baseline guard) and T072 (`libraryRestored`).
 *
 * These tests are EXPECTED TO FAIL against the code as it stands. They are
 * evidence, not a fix.
 */

function deck(id: string, name: string, updatedAt = 1, phrases: DeckRecord['phrases'] = []): DeckRecord {
  return { id, name, phrases, createdAt: 1, updatedAt }
}

function library(
  decks: readonly DeckRecord[],
  tombstones: Library['tombstones'] = [],
  schemaVersion = CURRENT_SCHEMA_VERSION,
): Library {
  return { format: LIBRARY_FORMAT, schemaVersion, exportedAt: 1, decks, mixes: [], tombstones }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i += 1) await Promise.resolve()
}

function manualScheduler(): Scheduler & { fire(): Promise<void> } {
  const tasks: { fn: () => void; cancelled: boolean }[] = []
  return {
    schedule(fn) {
      const task = { fn, cancelled: false }
      tasks.push(task)
      return () => {
        task.cancelled = true
      }
    },
    async fire() {
      const due = tasks.splice(0, tasks.length)
      for (const task of due) if (!task.cancelled) task.fn()
      await settle()
    },
  }
}

const alwaysOnline: PlatformPort = {
  isOnline: () => true,
  onOnline: () => () => {},
  onHidden: () => () => {},
}

interface HarnessOptions {
  local: Library
  serverLibrary?: Library
  baseline?: Library
  writeLocalFails?: boolean
}

function harness(options: HarnessOptions) {
  let local = options.local
  let serverLibrary = options.serverLibrary
  let baseline = options.baseline
  const scheduler = manualScheduler()
  const pushes: Library[] = []

  const engine: SyncEngine = createSyncEngine({
    client: {
      async pull() {
        return serverLibrary ? { ok: true, library: serverLibrary } : { ok: false, reason: 'not-found' }
      },
      async push(pushed) {
        pushes.push(pushed)
        serverLibrary = pushed
        return { ok: true }
      },
    },
    updateLocal: async (update) => {
      const next = update(local)
      if (options.writeLocalFails) throw new Error('quota exceeded')
      const changed = !sameLibraryContent(local, next) || !sameVoice(local.voice, next.voice)
      local = next
      return { library: next, changed }
    },
    baseline: {
      async read() {
        return baseline
      },
      async write(written) {
        baseline = written
      },
    },
    readLastSyncAt: async () => null,
    recordSync: async () => {},
    now: () => 5_000,
    scheduler,
    platform: alwaysOnline,
    debounceMs: 2_000,
  })

  return {
    engine,
    scheduler,
    pushes,
    get local() {
      return local
    },
    get baseline() {
      return baseline
    },
    get serverLibrary() {
      return serverLibrary
    },
    setLocal(next: Library) {
      local = next
    },
  }
}

describe('T080 audit — T070 baseline guard, seen from the engine', () => {
  /**
   * FINDING 1, consequence. `mergeLibraries` throws when the baseline's
   * `schemaVersion` differs from the local one, and nothing migrates a
   * persisted baseline. The engine cannot tell that apart from an envelope
   * written by a newer build, so it lands on `needs-update` and stops — for
   * good, on every launch, on a phone that is already running the newest
   * build. Her new phrases never reach the server and the only signal is a
   * line telling her to do something that will not help.
   */
  it('a baseline left behind by the previous schema version does not stop sync for good', async () => {
    const h = harness({
      local: library([deck('d1', 'Marché', 100)]),
      serverLibrary: library([deck('d1', 'Marché', 100)]),
      // Written by the last successful push before the schema bump.
      baseline: library([deck('d1', 'Marché', 100)], [], CURRENT_SCHEMA_VERSION - 1),
    })

    h.engine.start()
    await settle()

    expect(h.engine.snapshot().state).not.toBe('needs-update')
    expect(h.pushes).toHaveLength(1)
  })
})

describe('T080 audit — T072 libraryRestored', () => {
  /**
   * FINDING 3 (medium). `handleConfirmRestore` awaits `libraryRestored()`
   * BEFORE `writeLocal`, on the argument that "a restore applied on top of an
   * intact baseline is the defect happening". True — but the reverse is now
   * possible and nothing undoes it: when `writeLocal` fails, the baseline has
   * already been set to EMPTY and stays that way.
   *
   * `App.tsx` then tells her "That backup could not be restored on this
   * phone" and its comment states "nothing was replaced, and the Decks she
   * had are still the Decks she has". The Decks are — the baseline is not.
   *
   * An empty baseline makes every record on both sides read as written since
   * the last agreement, so the next round-trip drops every Tombstone the
   * server holds and resurrects every Deck she has ever deleted, on both
   * devices, permanently. She never asked for that and nothing tells her it
   * happened. It is not a loss of Phrases, which is why it is ranked below
   * findings 1 and 2 — but it is a silent, cross-device, irreversible effect
   * of an operation the app reported as having done nothing.
   */
  it('a restore whose local write fails does not leave the baseline emptied', async () => {
    const before = library([deck('d1', 'Marché', 100)])
    const h = harness({
      local: before,
      serverLibrary: before,
      baseline: before,
      writeLocalFails: true,
    })

    await h.engine.libraryRestored()
    // The write that follows it in `handleConfirmRestore` rejects.
    await expect(Promise.reject(new Error('quota exceeded'))).rejects.toThrow()

    expect(h.baseline).toEqual(before)
  })

  /**
   * FINDING 3, consequence — the deletion that comes back.
   *
   * Deck `d2` was deleted on her other phone; the server carries the Tombstone
   * and no longer carries the Deck. This phone still holds `d2` because it has
   * not synced since. A restore that FAILED has already emptied the baseline,
   * and the very next round-trip therefore reads `d2` as "written since the
   * last agreement", keeps it, and drops the Tombstone — so the deletion is
   * undone on the server too, not just here.
   */
  it('an emptied baseline from a failed restore does not undo a deletion made elsewhere', async () => {
    const localBefore = library([deck('d1', 'Marché', 100), deck('d2', 'Ancien', 100)])
    const onServer = library([deck('d1', 'Marché', 100)], [{ id: 'd2', kind: 'deck', deletedAt: 200 }])

    const failed = harness({
      local: localBefore,
      serverLibrary: onServer,
      baseline: localBefore,
      writeLocalFails: true,
    })
    await failed.engine.libraryRestored()

    // Now the next ordinary sync, run with whatever baseline is left behind.
    const after = harness({
      local: localBefore,
      serverLibrary: onServer,
      baseline: failed.baseline,
    })
    after.engine.start()
    await settle()

    const pushed = after.pushes[0]
    expect(pushed).toBeDefined()
    expect(pushed!.decks.map((d) => d.id)).toEqual(['d1'])
    expect(pushed!.tombstones).toEqual([{ id: 'd2', kind: 'deck', deletedAt: 200 }])
  })
})

describe('T080 audit — control: what held', () => {
  /** A baseline at the SAME schema version is fine. Finding 1 is about the bump alone. */
  it('merges normally when the baseline is at the current schema version', async () => {
    const h = harness({
      local: library([deck('d1', 'Marché', 100)]),
      serverLibrary: library([deck('d1', 'Marché', 100)]),
      baseline: library([deck('d1', 'Marché', 100)]),
    })
    h.engine.start()
    await settle()
    expect(h.engine.snapshot().state).toBe('idle')
  })

  /** `libraryRestored` on the happy path does what it says. */
  it('an empty baseline keeps every restored Deck against the server Tombstones', () => {
    const restored = library([deck('d1', 'Marché', 100)])
    const onServer = library([], [{ id: 'd1', kind: 'deck', deletedAt: 9_000 }])
    const merged = mergeLibraries(
      normalizeLibrary(restored),
      normalizeLibrary(onServer),
      library([]),
    )
    expect(merged.decks.map((d) => d.id)).toEqual(['d1'])
    expect(merged.tombstones).toEqual([])
  })
})
