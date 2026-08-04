import { describe, expect, it } from 'vitest'
import { LIBRARY_FORMAT, mergeLibraries, type DeckRecord, type Library } from '../../domain'
import { sameLibraryContent, sameVoice } from '../storage/library-identity'
import { CURRENT_SCHEMA_VERSION } from '../storage/migrations'
import { createSyncEngine, type PlatformPort, type Scheduler, type SyncEngine } from './sync-engine'

/**
 * AUDIT T079 — FINDING 1.
 *
 * The Sync Baseline is a whole `Library` envelope persisted in the `settings`
 * object store under `syncBaseline`
 * (`src/adapters/storage/sync-baseline-store.ts:29`). It carries the
 * `schemaVersion` that was current when it was written.
 *
 * NOTHING MIGRATES IT. `database.ts:120-134` migrates only records in the
 * `decks` store; the `settings` store is never rewritten by an upgrade, and
 * `sync-baseline-store.ts:42` reads the raw stored value straight back with no
 * `normalizeLibrary` in front of it. `sync-engine.ts:217` then passes that raw
 * value into `mergeLibraries` as `base`.
 *
 * `library-merge.ts:90-94` hard-throws when `base.schemaVersion` differs from
 * `local.schemaVersion` — and `local` has just been normalized UP to the new
 * `CURRENT_SCHEMA_VERSION`. So the first round-trip after any app upgrade that
 * bumps the schema throws inside the update function, `sync-engine.ts:239-246`
 * sets `refused = true`, and `roundTrip` returns `unreadable`, which
 * `sync-engine.ts:313-315` maps to `needs-update`.
 *
 * The result on her phone: sync is dead, permanently, on the very build that
 * was supposed to fix it, and the line reads "Saved on this phone · update the
 * app to sync". She has already updated the app. Nothing in the app clears or
 * rewrites the baseline, so no launch, no reconnect and no edit ever recovers
 * it. Her library stops leaving the phone and nothing says so truthfully.
 *
 * Every previous schema bump (v1→v6) shipped this. It has been survivable so
 * far only because the baseline itself is younger than most of them.
 */

function deck(id: string, name: string, updatedAt = 1, phrases: DeckRecord['phrases'] = []): DeckRecord {
  return { id, name, phrases, createdAt: 1, updatedAt }
}

function library(decks: readonly DeckRecord[], schemaVersion = CURRENT_SCHEMA_VERSION): Library {
  return {
    format: LIBRARY_FORMAT,
    schemaVersion,
    exportedAt: 1,
    decks,
    mixes: [],
    tombstones: [],
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i += 1) await Promise.resolve()
}

function manualScheduler(): Scheduler & { pending: number[] } {
  const tasks: { fn: () => void; ms: number; cancelled: boolean }[] = []
  return {
    schedule(fn, ms) {
      const task = { fn, ms, cancelled: false }
      tasks.push(task)
      return () => {
        task.cancelled = true
      }
    },
    get pending() {
      return tasks.filter((t) => !t.cancelled).map((t) => t.ms)
    },
  }
}

function alwaysOnline(): PlatformPort {
  return { isOnline: () => true, onOnline: () => () => {}, onHidden: () => () => {} }
}

describe('AUDIT T079 — a Sync Baseline written by the previous build kills sync forever', () => {
  it('the merge itself refuses a baseline one schema version behind', () => {
    // Exactly what is on disk the morning after an app update that bumped the
    // schema: her library, migrated up by the IndexedDB upgrade path, and a
    // baseline left at the version it was written under.
    const local = library([deck('d1', 'Home')], CURRENT_SCHEMA_VERSION)
    const remote = library([deck('d1', 'Home')], CURRENT_SCHEMA_VERSION)
    const staleBaseline = library([deck('d1', 'Home')], CURRENT_SCHEMA_VERSION - 1)

    // DEMONSTRATION: this throws. It should have merged.
    expect(() => mergeLibraries(local, remote, staleBaseline)).not.toThrow()
  })

  it('sync stops for good, and tells her to update an app she has already updated', async () => {
    let local = library([deck('d1', 'Home', 100)])
    let serverLibrary: Library | undefined = library([deck('d1', 'Home', 100)])
    const scheduler = manualScheduler()

    // The baseline as an upgraded phone finds it: written by the PREVIOUS
    // build, so one schema version behind, and never migrated by anything.
    let baseline: Library | undefined = library([deck('d1', 'Home', 100)], CURRENT_SCHEMA_VERSION - 1)

    const engine: SyncEngine = createSyncEngine({
      client: {
        async pull() {
          return serverLibrary ? { ok: true, library: serverLibrary } : { ok: false, reason: 'not-found' }
        },
        async push(pushed) {
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
      scheduler,
      platform: alwaysOnline(),
      debounceMs: 2_000,
    })

    engine.start()
    await settle()

    // DEMONSTRATION 1: the engine parks in the one state that never retries.
    expect(engine.snapshot().state).not.toBe('needs-update')

    // DEMONSTRATION 2: nothing is scheduled, so nothing will ever try again —
    // and the baseline is still the poisoned one, so nothing could succeed if
    // it did. This is permanent, on a phone whose app is current.
    expect(scheduler.pending).not.toEqual([])
    expect(baseline?.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
  })
})
