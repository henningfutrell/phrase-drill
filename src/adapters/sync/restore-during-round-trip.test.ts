import { describe, expect, it } from 'vitest'
import { LIBRARY_FORMAT, type DeckRecord, type Library, type Tombstone } from '../../domain'
import { sameLibraryContent, sameVoice } from '../storage/library-identity'
import { CURRENT_SCHEMA_VERSION } from '../storage/migrations'
import { createSyncEngine, type PlatformPort, type Scheduler, type SyncEngine } from './sync-engine'

/**
 * A restore from file and a round-trip, at the same time (T081).
 *
 * T072 made a restore outrank a deletion the server still holds by zeroing the
 * Sync Baseline before the restored library is written: with an EMPTY baseline
 * every restored record reads as written since the last agreement, so it
 * outranks a Tombstone the server kept. Every T072 test called
 * `libraryRestored()` with the engine idle, and the engine is not idle when
 * she taps Restore — it syncs on launch, on reconnect and two seconds after
 * every edit.
 *
 * Two windows were open, and both ended with her phrases gone:
 *
 * 1. **A round-trip pushing.** The last thing a successful round-trip does is
 *    write the library it pushed into the baseline. That library was computed
 *    before the restore. It landed on top of the empty baseline the restore
 *    had just written, so the very next merge read every restored Deck as
 *    unchanged since the last agreement and let the server's Tombstone delete
 *    it — on the phone and on the server. The T072 defect verbatim, through a
 *    race T072 did not close.
 *
 * 2. **A round-trip reading.** The same snapshot, one step earlier: a
 *    round-trip that read the pre-restore baseline and then merged the
 *    restored library against it deletes the restored Deck without any push at
 *    all.
 *
 * And the opposite order had its own loss: the baseline is emptied *first*, on
 * purpose (T072 — a restore applied on top of an intact baseline is the defect
 * happening), so a local write that then failed left an empty baseline over an
 * unchanged library. Every Tombstone she ever wrote then reads as written
 * since the agreement, and the next merge resurrects every Deck she has ever
 * deleted, here and on the server.
 *
 * The fix makes the two writes one operation the engine owns: `libraryRestored`
 * takes the local write, counts the restore before it empties the baseline so
 * a round-trip already in flight recognises itself as superseded and writes
 * nothing, and puts the previous baseline back if the local write refuses.
 */

function deck(id: string, name: string, updatedAt = 1, phrases: DeckRecord['phrases'] = []): DeckRecord {
  return { id, name, phrases, createdAt: 1, updatedAt }
}

function library(decks: readonly DeckRecord[], tombstones: readonly Tombstone[] = []): Library {
  return {
    format: LIBRARY_FORMAT,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    exportedAt: 1,
    decks,
    mixes: [],
    tombstones,
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i += 1) await Promise.resolve()
}

/** Timers that never fire on their own, so "nothing retried" is observable. */
function manualScheduler(): Scheduler & { pending: number[] } {
  const tasks: { ms: number; cancelled: boolean }[] = []
  return {
    schedule(_fn, ms) {
      const task = { ms, cancelled: false }
      tasks.push(task)
      return () => {
        task.cancelled = true
      }
    },
    get pending() {
      return tasks.filter((task) => !task.cancelled).map((task) => task.ms)
    },
  }
}

function alwaysOnline(): PlatformPort {
  return { isOnline: () => true, onOnline: () => () => {}, onHidden: () => () => {} }
}

/** The engine, a server whose PULL and PUSH can each be held open, and the device's stores. */
function harness(initialLocal: Library, initialServer: Library | undefined) {
  let local = initialLocal
  let serverLibrary = initialServer
  let baseline: Library | undefined
  let releasePush: (() => void) | undefined
  let releasePull: (() => void) | undefined
  let holdPush = false
  let holdPull = false
  let baselineWriteFault: Error | undefined
  const scheduler = manualScheduler()

  const engine: SyncEngine = createSyncEngine({
    client: {
      async pull() {
        if (holdPull) {
          await new Promise<void>((resolve) => {
            releasePull = resolve
          })
        }
        return serverLibrary ? { ok: true, library: serverLibrary } : { ok: false, reason: 'not-found' }
      },
      async push(pushed) {
        if (holdPush) {
          await new Promise<void>((resolve) => {
            releasePush = resolve
          })
        }
        serverLibrary = pushed
        return { ok: true }
      },
    },
    updateLocal: async (update) => {
      const next = update(local)
      const changed = !sameLibraryContent(local, next) || !sameVoice(local.voice, next.voice)
      local = next
      return { library: next, changed }
    },
    baseline: {
      async read() {
        return baseline
      },
      async write(written) {
        if (baselineWriteFault) throw baselineWriteFault
        baseline = written
      },
    },
    readLastSyncAt: async () => null,
    recordSync: async () => {},
    now: () => 1_000,
    scheduler,
    platform: alwaysOnline(),
    debounceMs: 2_000,
  })

  return {
    engine,
    scheduler,
    get local() {
      return local
    },
    setLocal(next: Library) {
      local = next
    },
    get server() {
      return serverLibrary
    },
    setServer(next: Library) {
      serverLibrary = next
    },
    get baseline() {
      return baseline
    },
    failBaselineWrite(error: Error) {
      baselineWriteFault = error
    },
    holdNextPush() {
      holdPush = true
    },
    async releaseHeldPush() {
      holdPush = false
      releasePush?.()
      releasePush = undefined
      await settle()
    },
    holdNextPull() {
      holdPull = true
    },
    async releaseHeldPull() {
      holdPull = false
      releasePull?.()
      releasePull = undefined
      await settle()
    },
  }
}

describe('createSyncEngine — a restore confirmed while a round-trip is pushing (T081)', () => {
  it('leaves the empty baseline the restore wrote, instead of putting the pre-restore snapshot back', async () => {
    const h = harness(library([deck('d1', 'Home', 100)]), library([deck('d1', 'Home', 100)]))

    // A launch sync, to get the two sides agreed. Baseline now holds d1.
    h.engine.start()
    await settle()
    expect(h.baseline?.decks).toHaveLength(1)

    // Any later round-trip — an edit, a reconnect, the next launch. Its push
    // is on the network and has not answered yet.
    h.holdNextPush()
    h.engine.syncNow()
    await settle()

    // She confirms a restore. The engine owns both writes.
    await h.engine.libraryRestored(async () => {
      h.setLocal(library([deck('d1', 'Home', 100)]))
    })
    expect(h.baseline?.decks).toEqual([])

    // The push finally lands.
    await h.releaseHeldPush()

    // "This device and the server agree on nothing" survives the push that
    // was already in flight when she confirmed.
    expect(h.baseline?.decks).toEqual([])
  })

  it('and the Deck she restored is not deleted again, on the phone or on the server', async () => {
    // T072's own second case (docs/sync.md, "A phone that has not yet picked up
    // the other device's deletion"), with a round-trip in flight.
    const h = harness(library([deck('d1', 'Home', 100)]), library([deck('d1', 'Home', 100)]))

    h.engine.start()
    await settle()
    expect(h.baseline?.decks).toHaveLength(1)

    // A round-trip is pushing.
    h.holdNextPush()
    h.engine.syncNow()
    await settle()

    // She restores a backup that carries d1 byte for byte.
    await h.engine.libraryRestored(async () => {
      h.setLocal(library([deck('d1', 'Home', 100)]))
    })

    // The push lands, into a baseline that no longer describes this device.
    await h.releaseHeldPush()

    // Meanwhile the other phone's deletion of d1 has reached the server.
    h.setServer(library([], [{ id: 'd1', kind: 'deck', deletedAt: 500 }]))

    // The restore's own sync, which the composition root fires next.
    h.engine.syncNow()
    await settle()

    expect(h.local.decks.map((d) => d.id)).toEqual(['d1'])
    expect(h.server?.tombstones).toEqual([])
  })

  it('claims no sync time for the superseded round-trip, and keeps trying', async () => {
    const h = harness(library([deck('d1', 'Home', 100)]), library([deck('d1', 'Home', 100)]))

    h.holdNextPush()
    h.engine.start()
    await settle()

    await h.engine.libraryRestored(async () => {
      h.setLocal(library([deck('d1', 'Home', 100)]))
    })
    await h.releaseHeldPush()

    // The server did accept that push — but what is on this phone now is the
    // restored library, and that has not been anywhere. Saying "everything on
    // this device is on the server" would be false.
    expect(h.engine.snapshot().state).toBe('waiting')
    expect(h.engine.snapshot().lastSyncAt).toBeNull()
    expect(h.scheduler.pending).not.toEqual([])
  })

  it('does not merge the restored library against the baseline the restore replaced', async () => {
    // The other window: a round-trip that has already READ the pre-restore
    // baseline, and reaches the merge after the restore has been applied. No
    // push is needed to lose the Deck.
    const h = harness(library([deck('d1', 'Home', 100)]), library([deck('d1', 'Home', 100)]))

    h.engine.start()
    await settle()
    expect(h.baseline?.decks).toHaveLength(1)

    // The other phone deleted d1. This round-trip is still on the pull.
    h.setServer(library([], [{ id: 'd1', kind: 'deck', deletedAt: 500 }]))
    h.holdNextPull()
    h.engine.syncNow()
    await settle()

    await h.engine.libraryRestored(async () => {
      h.setLocal(library([deck('d1', 'Home', 100)]))
    })

    await h.releaseHeldPull()

    expect(h.local.decks.map((d) => d.id)).toEqual(['d1'])
    expect(h.baseline?.decks).toEqual([])
  })

  it('still records what the two sides agreed on when no restore happened', async () => {
    // The guard is on a restore, not on round-trips in general.
    const h = harness(library([deck('d1', 'Home', 100)]), library([deck('d1', 'Home', 100)]))

    h.holdNextPush()
    h.engine.start()
    await settle()
    await h.releaseHeldPush()

    expect(h.baseline?.decks.map((d) => d.id)).toEqual(['d1'])
    expect(h.engine.snapshot().state).toBe('idle')
    expect(h.engine.snapshot().lastSyncAt).toBe(1_000)
  })
})

describe('createSyncEngine — a restore whose local write fails (T081)', () => {
  it('puts back the baseline it emptied, so nothing reads as written since the agreement', async () => {
    const h = harness(library([deck('d1', 'Home', 100)]), library([deck('d1', 'Home', 100)]))
    h.engine.start()
    await settle()
    const agreed = h.baseline
    expect(agreed?.decks).toHaveLength(1)

    await expect(
      h.engine.libraryRestored(async () => {
        throw new Error('QuotaExceededError')
      }),
    ).rejects.toThrow('QuotaExceededError')

    expect(h.baseline).toEqual(agreed)
  })

  it('and her deletions still stand on the next round-trip', async () => {
    // Agree first: the baseline holds d1, which is the state before she
    // deleted it. This is what makes the Tombstone able to delete (T070).
    const h = harness(library([deck('d1', 'Home', 100)]), library([deck('d1', 'Home', 100)]))
    h.engine.start()
    await settle()
    expect(h.baseline?.decks).toHaveLength(1)

    // She deletes d1 here. The other phone has not heard yet.
    h.setLocal(library([], [{ id: 'd1', kind: 'deck', deletedAt: 600 }]))
    h.setServer(library([deck('d1', 'Home', 100)]))

    await expect(
      h.engine.libraryRestored(async () => {
        throw new Error('QuotaExceededError')
      }),
    ).rejects.toThrow('QuotaExceededError')

    h.engine.syncNow()
    await settle()

    // Resurrecting a Deck she deleted, here and on the server, is what an
    // empty baseline over an unchanged library does.
    expect(h.local.decks).toEqual([])
    expect(h.server?.decks).toEqual([])
    expect(h.server?.tombstones.map((t) => t.id)).toEqual(['d1'])
  })

  it('refuses the restore outright when the empty baseline cannot be written, and applies nothing', async () => {
    // T072's ordering, kept: a restore applied on top of an intact baseline is
    // the defect happening, so a baseline that cannot be recorded stops it.
    const h = harness(library([deck('d1', 'Home', 100)]), library([deck('d1', 'Home', 100)]))
    h.engine.start()
    await settle()

    let applied = false
    h.failBaselineWrite(new Error('QuotaExceededError'))

    await expect(
      h.engine.libraryRestored(async () => {
        applied = true
      }),
    ).rejects.toThrow('QuotaExceededError')

    expect(applied).toBe(false)
    expect(h.local.decks.map((d) => d.id)).toEqual(['d1'])
  })

  it('keeps the empty baseline when there was none to put back', async () => {
    // A phone that has never synced. There is no previous agreement to
    // restore, and the two candidates are not equal: EMPTY resurrects a
    // deletion, ABSENT lets a Tombstone delete on its clock alone. Only one of
    // those can lose a Phrase, so the empty one stays.
    const h = harness(library([deck('d1', 'Home', 100)]), undefined)

    await expect(
      h.engine.libraryRestored(async () => {
        throw new Error('QuotaExceededError')
      }),
    ).rejects.toThrow('QuotaExceededError')

    expect(h.baseline).toMatchObject({ decks: [], mixes: [], tombstones: [] })
  })
})
