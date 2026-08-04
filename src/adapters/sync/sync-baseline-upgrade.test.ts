import { describe, expect, it } from 'vitest'
import { LIBRARY_FORMAT, mergeLibraries, type DeckRecord, type Library, type Tombstone } from '../../domain'
import { sameLibraryContent, sameVoice } from '../storage/library-identity'
import { CURRENT_SCHEMA_VERSION } from '../storage/migrations'
import { createSyncEngine, type PlatformPort, type Scheduler, type SyncEngine } from './sync-engine'

/**
 * The Sync Baseline outliving the build that wrote it (T081).
 *
 * The baseline is a whole `Library` envelope persisted in the `settings`
 * object store under `syncBaseline`, and NOTHING migrates it: the IndexedDB
 * upgrade path rewrites records in the `decks` store only, and the baseline
 * store reads its value straight back with no normalization in front of it.
 * The library beside it IS migrated. So the morning after any app update that
 * bumps the schema, the two are one version apart.
 *
 * `mergeLibraries` refused that outright (T070, for the good reason that two
 * envelopes of different shapes cannot be compared record by record), the
 * engine read the refusal as an envelope this build cannot understand, and
 * parked at `needs-update` — the one state that never retries, because
 * retrying the same build gets the same answer. Sync was then dead on a phone
 * whose app was already current, permanently, with the line telling her to
 * update it. No race, no second device: it fired for every user on the next
 * bump, and it silently removed the only thing keeping her library alive
 * anywhere but one phone.
 *
 * A baseline this build cannot compare against is a baseline it does not have.
 * That is what the thing has always claimed to be — derived, regenerable
 * bookkeeping whose loss costs the next merge its precision and nothing else
 * (docs/glossary.md, `sync-baseline-store.ts`) — and the next accepted push
 * writes a fresh one at the current version, so the cost is one round-trip.
 *
 * What must NOT collapse with it: an EMPTY baseline at the current version is
 * still a baseline, and it means the opposite thing (T072). Absent is "nothing
 * can be shown", under which a Tombstone wins on its clock alone. Empty is
 * "we agreed on nothing", under which every record on this device outranks a
 * Tombstone. Only the VERSION decides which of the two an unusable baseline
 * becomes.
 */

function deck(id: string, name: string, updatedAt = 1, phrases: DeckRecord['phrases'] = []): DeckRecord {
  return { id, name, phrases, createdAt: 1, updatedAt }
}

function library(
  decks: readonly DeckRecord[],
  schemaVersion = CURRENT_SCHEMA_VERSION,
  tombstones: readonly Tombstone[] = [],
): Library {
  return {
    format: LIBRARY_FORMAT,
    schemaVersion,
    exportedAt: 1,
    decks,
    mixes: [],
    tombstones,
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i += 1) await Promise.resolve()
}

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

describe('mergeLibraries — a baseline from another build (T081)', () => {
  it('merges instead of throwing when the baseline is one schema version behind', () => {
    // Exactly what is on disk the morning after an app update that bumped the
    // schema: her library, migrated up by the IndexedDB upgrade path, and a
    // baseline left at the version it was written under.
    const local = library([deck('d1', 'Home')], CURRENT_SCHEMA_VERSION)
    const remote = library([deck('d1', 'Home')], CURRENT_SCHEMA_VERSION)
    const staleBaseline = library([deck('d1', 'Home')], CURRENT_SCHEMA_VERSION - 1)

    expect(() => mergeLibraries(local, remote, staleBaseline)).not.toThrow()
  })

  it('reads such a baseline as absent, not as one that happens to agree', () => {
    // Told the baseline says d1 is unchanged here, the merge hands back the
    // other device's whole record. Told nothing, it falls back to the later
    // `updatedAt`. The two answers differ, which is what makes this
    // observable at all.
    const local = library([deck('d1', 'Home', 30)])
    const remote = library([deck('d1', 'Renamed', 20)])
    const stale: Library = { ...library([deck('d1', 'Home', 30)]), schemaVersion: CURRENT_SCHEMA_VERSION - 1 }

    expect(mergeLibraries(local, remote, stale).decks.map((d) => d.name)).toEqual(['Home'])
    expect(mergeLibraries(local, remote).decks.map((d) => d.name)).toEqual(['Home'])
  })

  it('reads a baseline from a NEWER build the same way', () => {
    // The rolled-back deploy: the database was upgraded by a build she then
    // went back from. Nothing about that is worth killing sync over either.
    const local = library([deck('d1', 'Home', 30)])
    const remote = library([deck('d1', 'Renamed', 20)])
    const ahead: Library = { ...library([deck('d1', 'Home', 30)]), schemaVersion: CURRENT_SCHEMA_VERSION + 1 }

    expect(mergeLibraries(local, remote, ahead).decks.map((d) => d.name)).toEqual(['Home'])
  })

  it('keeps EMPTY and ABSENT apart, because they decide a deletion differently', () => {
    // The T072 mechanism, pinned against the change above: only the version is
    // judged, so an empty baseline at the current version is still a baseline.
    const local = library([deck('d1', 'Home', 100)])
    const remote = library([], CURRENT_SCHEMA_VERSION, [{ id: 'd1', kind: 'deck', deletedAt: 500 }])
    const empty = library([])

    // Empty: d1 was written since the agreement, so it outranks the Tombstone.
    expect(mergeLibraries(local, remote, empty).decks.map((d) => d.id)).toEqual(['d1'])
    // Absent: nothing can be shown, so the Tombstone wins on its clock.
    expect(mergeLibraries(local, remote).decks).toEqual([])
  })

  it('still refuses two LIBRARIES at different schema versions', () => {
    // Unchanged: those are her records on both sides, and comparing envelopes
    // of different shapes would lose one.
    const older: Library = { ...library([]), schemaVersion: CURRENT_SCHEMA_VERSION - 1 }

    expect(() => mergeLibraries(library([]), older)).toThrow(/schema version/)
  })
})

describe('createSyncEngine — the first launch after a schema bump (T081)', () => {
  it('syncs, and rewrites the baseline at the current version', async () => {
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

    // Not `needs-update`: there is no newer app, and telling her to fetch one
    // is both false and unactionable.
    expect(engine.snapshot().state).toBe('idle')
    // Nothing is scheduled because nothing needs retrying — the round-trip
    // succeeded, rather than parking in the state that never tries again.
    expect(scheduler.pending).toEqual([])
    // And the poisoned value is gone: one round-trip of degraded precision,
    // which is the whole of what losing a baseline is supposed to cost.
    expect(baseline?.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
    expect(baseline?.decks.map((d) => d.id)).toEqual(['d1'])
  })
})
