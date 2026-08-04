import { describe, expect, it } from 'vitest'
import { LIBRARY_FORMAT, type DeckRecord, type Library } from '../../domain'
import { sameLibraryContent, sameVoice } from '../storage/library-identity'
import { CURRENT_SCHEMA_VERSION } from '../storage/migrations'
import { createSyncEngine, type PlatformPort, type Scheduler, type SyncEngine } from './sync-engine'

/**
 * AUDIT T079 — FINDING 2.
 *
 * T072 made a restore from file outrank a deletion the server still holds, by
 * zeroing the Sync Baseline: `syncEngine.libraryRestored()`
 * (`sync-engine.ts:424-426`) writes an empty library, and `App.tsx:550-560`
 * awaits it BEFORE the library is written. Every existing test for it calls
 * `libraryRestored()` with the engine idle (`sync-engine.test.ts:786, 806,
 * 827`).
 *
 * Nothing coordinates it with a round-trip that is already running, and the
 * engine keeps running throughout — `handleConfirmRestore` never stops it. The
 * last thing a successful round-trip does is
 *
 *     sync-engine.ts:269   await deps.baseline.write(outgoing)
 *
 * where `outgoing` was computed at `sync-engine.ts:235`, before the restore.
 * The push in between (`sync-engine.ts:256`) is a network call — on her phone,
 * seconds. A restore confirmed inside that window sets the baseline to empty
 * and is then silently overwritten by the pre-restore snapshot when the push
 * lands.
 *
 * The baseline is back to holding exactly the records the restore was supposed
 * to have disowned, so the very next round-trip — the one the restore itself
 * kicks off, `App.tsx:573` — reads a restored Deck as "unchanged since the last
 * agreed state" and lets the server's Tombstone through. That is the T072
 * defect, verbatim, restored by a race: she watches the restore work and then
 * watches it vanish, against handwritten phrases that exist nowhere else.
 */

function deck(id: string, name: string, updatedAt = 1, phrases: DeckRecord['phrases'] = []): DeckRecord {
  return { id, name, phrases, createdAt: 1, updatedAt }
}

function library(decks: readonly DeckRecord[], tombstones: Library['tombstones'] = []): Library {
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

function manualScheduler(): Scheduler {
  return { schedule: () => () => {} }
}

function alwaysOnline(): PlatformPort {
  return { isOnline: () => true, onOnline: () => () => {}, onHidden: () => () => {} }
}

/** The engine, a server whose PUSH can be held open, and the device's stores. */
function harness(initialLocal: Library, initialServer: Library | undefined) {
  let local = initialLocal
  let serverLibrary = initialServer
  let baseline: Library | undefined
  let releasePush: (() => void) | undefined
  let holdPush = false

  const engine: SyncEngine = createSyncEngine({
    client: {
      async pull() {
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
        baseline = written
      },
    },
    readLastSyncAt: async () => null,
    recordSync: async () => {},
    now: () => 1_000,
    scheduler: manualScheduler(),
    platform: alwaysOnline(),
    debounceMs: 2_000,
  })

  return {
    engine,
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
    holdNextPush() {
      holdPush = true
    },
    async releaseHeldPush() {
      holdPush = false
      releasePush?.()
      releasePush = undefined
      await settle()
    },
  }
}

describe('AUDIT T079 — a restore confirmed while a round-trip is pushing is silently undone', () => {
  it('the in-flight push overwrites the empty baseline the restore just wrote', async () => {
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

    // She confirms a restore. App.tsx awaits this before writing the library.
    await h.engine.libraryRestored()
    expect(h.baseline?.decks).toEqual([])

    // The push finally lands.
    await h.releaseHeldPush()

    // DEMONSTRATION: "this device and the server agree on nothing" has been
    // silently replaced by the pre-restore snapshot.
    expect(h.baseline?.decks).toEqual([])
  })

  it('and the Deck she restored is then deleted again, on the phone and on the server', async () => {
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

    // She restores a backup that carries d1 byte for byte. App.tsx:559-560:
    // record that nothing is agreed, then write the library.
    await h.engine.libraryRestored()
    h.setLocal(library([deck('d1', 'Home', 100)]))

    // The push lands, and puts the pre-restore snapshot back in the baseline.
    await h.releaseHeldPush()

    // Meanwhile the other phone's deletion of d1 has reached the server.
    h.setServer(library([], [{ id: 'd1', kind: 'deck', deletedAt: 500 }]))

    // The restore's own sync (App.tsx:573).
    h.engine.syncNow()
    await settle()

    // DEMONSTRATION: her restored Deck is gone from this phone, and the
    // deletion still stands on the server. Nothing was said.
    expect(h.local.decks.map((d) => d.id)).toEqual(['d1'])
    expect(h.server?.tombstones).toEqual([])
  })
})
