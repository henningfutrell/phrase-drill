import { describe, expect, it, vi } from 'vitest'
import { LIBRARY_FORMAT, type DeckRecord, type Library } from '../../domain'
import { CURRENT_SCHEMA_VERSION } from '../storage/migrations'
import type { LibrarySyncClient, PullResult, PushResult } from './library-sync-client'
import { createSyncEngine, type PlatformPort, type Scheduler, type SyncEngine } from './sync-engine'

function deck(id: string, name: string, updatedAt = 1, phrases: DeckRecord['phrases'] = []): DeckRecord {
  return { id, name, phrases, createdAt: 1, updatedAt }
}

function library(decks: readonly DeckRecord[], exportedAt = 1): Library {
  return {
    format: LIBRARY_FORMAT,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    exportedAt,
    decks,
    mixes: [],
    tombstones: [],
  }
}

/** Every pending microtask, several chains deep — the engine's round-trip is
 * pull → read → merge → write → push → record, each its own await. */
async function settle(): Promise<void> {
  for (let i = 0; i < 30; i += 1) await Promise.resolve()
}

/**
 * A scheduler whose timers only fire when the test says so, so a debounce
 * window is asserted rather than waited out. Records the delay it was asked
 * for, which is how the debounce and the retry backoff are pinned.
 */
function createManualScheduler(): Scheduler & { pending: number[]; fire(): Promise<void> } {
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
    async fire() {
      const due = tasks.splice(0, tasks.length)
      for (const task of due) if (!task.cancelled) task.fn()
      await settle()
    },
  }
}

function createManualPlatform(): PlatformPort & { goOnline(): void; hide(): void; online: boolean } {
  const onlineListeners: (() => void)[] = []
  const hiddenListeners: (() => void)[] = []
  const platform = {
    online: true,
    isOnline: () => platform.online,
    onOnline(listener: () => void) {
      onlineListeners.push(listener)
      return () => onlineListeners.splice(onlineListeners.indexOf(listener), 1)
    },
    onHidden(listener: () => void) {
      hiddenListeners.push(listener)
      return () => hiddenListeners.splice(hiddenListeners.indexOf(listener), 1)
    },
    goOnline() {
      platform.online = true
      for (const listener of [...onlineListeners]) listener()
    },
    hide() {
      for (const listener of [...hiddenListeners]) listener()
    },
  }
  return platform
}

/** A server that holds one library, with both directions independently
 * switchable so "offline" and "read-only" are both expressible. */
function createFakeServer(initial?: Library) {
  const server = {
    library: initial,
    pushes: [] as Library[],
    pulls: 0,
    pullResult: undefined as PullResult | undefined,
    pushResult: undefined as PushResult | undefined,
    client(): LibrarySyncClient {
      return {
        async pull() {
          server.pulls += 1
          if (server.pullResult) return server.pullResult
          return server.library ? { ok: true, library: server.library } : { ok: false, reason: 'not-found' }
        },
        async push(pushed) {
          if (server.pushResult) return server.pushResult
          server.pushes.push(pushed)
          server.library = pushed
          return { ok: true }
        },
      }
    },
  }
  return server
}

function createFakeBaseline() {
  let held: Library | undefined
  return {
    async read() {
      return held
    },
    async write(l: Library) {
      held = l
    },
    get value() {
      return held
    },
  }
}

function createHarness(options: { local?: Library; server?: ReturnType<typeof createFakeServer>; lastSyncAt?: number | null } = {}) {
  const server = options.server ?? createFakeServer()
  let local = options.local ?? library([])
  const scheduler = createManualScheduler()
  const platform = createManualPlatform()
  const baseline = createFakeBaseline()
  const recorded: number[] = []
  const clock = { value: 1_000 }
  const engine: SyncEngine = createSyncEngine({
    client: server.client(),
    readLocal: async () => local,
    writeLocal: async (written) => {
      local = written
    },
    baseline,
    readLastSyncAt: async () => options.lastSyncAt ?? null,
    recordSync: async (timestamp) => {
      recorded.push(timestamp)
    },
    now: () => clock.value,
    scheduler,
    platform,
    debounceMs: 2_000,
  })
  return {
    engine,
    server,
    scheduler,
    platform,
    baseline,
    recorded,
    clock,
    get local() {
      return local
    },
    /** Stands in for a local save made between two syncs. */
    setLocal(next: Library) {
      local = next
    },
  }
}

describe('createSyncEngine — syncing without a tap (T034)', () => {
  it('syncs at launch: pulls, then pushes, with nobody touching a control', async () => {
    const h = createHarness({ local: library([deck('d1', 'Home')]) })

    h.engine.start()
    await settle()

    expect(h.server.pulls).toBe(1)
    expect(h.server.pushes).toHaveLength(1)
    expect(h.server.pushes[0]!.decks.map((d) => d.name)).toEqual(['Home'])
  })

  it('debounces a burst of changes into one round-trip, so a phone is not woken per keystroke', async () => {
    const h = createHarness()
    h.engine.start()
    await settle()
    const afterLaunch = h.server.pushes.length

    h.engine.requestSync()
    h.engine.requestSync()
    h.engine.requestSync()
    expect(h.server.pushes.length).toBe(afterLaunch)

    await h.scheduler.fire()

    expect(h.server.pushes.length).toBe(afterLaunch + 1)
  })

  it('waits the chosen debounce window and no other, so the choice is not accidental', async () => {
    const h = createHarness()
    h.engine.start()
    await settle()

    h.engine.requestSync()

    expect(h.scheduler.pending).toEqual([2_000])
  })

  it('coalesces changes made while a sync is in flight into exactly one follow-up round-trip', async () => {
    const server = createFakeServer()
    const live = server.client()
    let releaseFirstPull: (() => void) | undefined
    const client: LibrarySyncClient = {
      push: live.push,
      pull: async () => {
        if (releaseFirstPull === undefined) {
          await new Promise<void>((resolve) => {
            releaseFirstPull = resolve
          })
        }
        return live.pull()
      },
    }
    // A scheduler with no delay at all, so `requestSync` lands while the
    // launch round-trip is still waiting on its pull.
    const immediate: Scheduler = {
      schedule(fn) {
        fn()
        return () => {}
      },
    }
    const engine = createSyncEngine({
      client,
      readLocal: async () => library([]),
      writeLocal: async () => {},
      baseline: createFakeBaseline(),
      readLastSyncAt: async () => null,
      recordSync: async () => {},
      now: () => 1,
      scheduler: immediate,
      platform: createManualPlatform(),
      debounceMs: 0,
    })

    engine.start()
    await settle()
    engine.requestSync()
    engine.requestSync()
    engine.requestSync()
    releaseFirstPull?.()
    await settle()

    expect(server.pushes.length).toBe(2)
  })

  it('flushes immediately when the app is backgrounded, so locking the phone does not strand a change', async () => {
    const h = createHarness()
    h.engine.start()
    await settle()
    const afterLaunch = h.server.pushes.length

    h.engine.requestSync()
    h.platform.hide()
    await settle()

    expect(h.server.pushes.length).toBe(afterLaunch + 1)
  })

  it('stops touching the network once stopped', async () => {
    const h = createHarness()
    h.engine.start()
    await settle()
    const afterLaunch = h.server.pushes.length

    h.engine.stop()
    h.engine.requestSync()
    await h.scheduler.fire()
    h.platform.goOnline()
    await settle()

    expect(h.server.pushes.length).toBe(afterLaunch)
  })
})

describe('createSyncEngine — what she can see', () => {
  it('reports the time of the sync that just succeeded, from the injected clock', async () => {
    const h = createHarness()
    h.clock.value = 5_000

    h.engine.start()
    await settle()

    expect(h.engine.snapshot().lastSyncAt).toBe(5_000)
    expect(h.engine.snapshot().state).toBe('idle')
    expect(h.recorded).toEqual([5_000])
  })

  it('restores the last successful sync time at launch, so a relaunch does not report never-synced', async () => {
    const h = createHarness({ lastSyncAt: 42 })
    h.server.pullResult = { ok: false, reason: 'network' }

    h.engine.start()
    await settle()

    expect(h.engine.snapshot().lastSyncAt).toBe(42)
  })

  it('never reports a sync that failed as a sync', async () => {
    const h = createHarness()
    h.server.pushResult = { ok: false, reason: 'network' }

    h.engine.start()
    await settle()

    expect(h.engine.snapshot().lastSyncAt).toBeNull()
    expect(h.engine.snapshot().state).toBe('waiting')
    expect(h.recorded).toEqual([])
  })

  it('tells subscribers about every state it passes through', async () => {
    const h = createHarness()
    const seen: string[] = []
    h.engine.subscribe((snapshot) => seen.push(snapshot.state))

    h.engine.start()
    await settle()

    expect(seen).toContain('syncing')
    expect(seen[seen.length - 1]).toBe('idle')
  })

  it('drops a subscriber that unsubscribed', async () => {
    const h = createHarness()
    const listener = vi.fn()
    const unsubscribe = h.engine.subscribe(listener)

    unsubscribe()
    h.engine.start()
    await settle()

    expect(listener).not.toHaveBeenCalled()
  })

  it('says a change is waiting the moment one is requested, before any network is touched', async () => {
    const h = createHarness()
    h.engine.start()
    await settle()

    h.engine.requestSync()

    expect(h.engine.snapshot().state).toBe('waiting')
  })

  it('counts a library revision only when the merge actually changed what is stored locally', async () => {
    const server = createFakeServer(library([deck('remote', 'From the web', 5)]))
    const h = createHarness({ local: library([deck('d1', 'Home')]), server })

    h.engine.start()
    await settle()
    const afterMerge = h.engine.snapshot().libraryRevision

    h.engine.syncNow()
    await settle()

    expect(afterMerge).toBe(1)
    expect(h.engine.snapshot().libraryRevision).toBe(1)
  })
})

describe('createSyncEngine — offline, and catching up', () => {
  it('keeps an offline change and pushes it once the connection comes back', async () => {
    const h = createHarness({ local: library([deck('d1', 'Made offline', 10)]) })
    h.server.pushResult = { ok: false, reason: 'network' }
    h.platform.online = false

    h.engine.start()
    await settle()
    expect(h.server.pushes).toEqual([])

    h.server.pushResult = undefined
    h.platform.goOnline()
    await settle()

    expect(h.server.pushes.map((l) => l.decks.map((d) => d.name))).toEqual([['Made offline']])
    expect(h.engine.snapshot().state).toBe('idle')
  })

  it('retries on its own after a failed round-trip, without waiting for a connection event', async () => {
    const h = createHarness({ local: library([deck('d1', 'Home')]) })
    h.server.pushResult = { ok: false, reason: 'network' }

    h.engine.start()
    await settle()
    expect(h.scheduler.pending.length).toBe(1)

    h.server.pushResult = undefined
    await h.scheduler.fire()

    expect(h.server.pushes).toHaveLength(1)
  })

  it('backs off between retries rather than hammering a dead connection', async () => {
    const h = createHarness()
    h.server.pushResult = { ok: false, reason: 'network' }

    h.engine.start()
    await settle()
    const first = h.scheduler.pending[0]!
    await h.scheduler.fire()
    const second = h.scheduler.pending[0]!

    expect(second).toBeGreaterThan(first)
  })

  it('does not push at all when it could not read the server copy first — a device that cannot merge must not overwrite', async () => {
    const server = createFakeServer(library([deck('remote', 'Only on the server', 5)]))
    const h = createHarness({ local: library([deck('d1', 'Home')]), server })
    server.pullResult = { ok: false, reason: 'network' }

    h.engine.start()
    await settle()

    expect(server.pushes).toEqual([])
    expect(server.library!.decks.map((d) => d.name)).toEqual(['Only on the server'])
  })

  it('writes the merged library back locally before pushing, so what came down is kept even if the push fails', async () => {
    const server = createFakeServer(library([deck('remote', 'From the web', 5)]))
    const h = createHarness({ local: library([deck('d1', 'Home')]), server })
    server.pushResult = { ok: false, reason: 'network' }

    h.engine.start()
    await settle()

    expect(h.local.decks.map((d) => d.name).sort()).toEqual(['From the web', 'Home'])
  })

  it('does not move the baseline forward on a failed push — the agreed state is what both sides really hold', async () => {
    const h = createHarness()
    h.server.pushResult = { ok: false, reason: 'network' }

    h.engine.start()
    await settle()

    expect(h.baseline.value).toBeUndefined()
  })

  it('records the pushed library as the new baseline once the server has accepted it', async () => {
    const h = createHarness({ local: library([deck('d1', 'Home')]) })

    h.engine.start()
    await settle()

    expect(h.baseline.value!.decks.map((d) => d.id)).toEqual(['d1'])
  })

  it('merges against the baseline, so two devices editing one Deck keep both Phrases', async () => {
    const shared = deck('d1', 'Home', 1, [{ id: 'p1', french: 'Bonjour', english: 'Hello' }])
    const server = createFakeServer(library([shared]))
    const h = createHarness({ local: library([shared]), server })

    // Both sides agree; this establishes the baseline.
    h.engine.start()
    await settle()

    expect(h.baseline.value!.decks[0]!.phrases.map((p) => p.id)).toEqual(['p1'])

    // The other device adds one Phrase; this one adds a different Phrase.
    server.library = library([
      deck('d1', 'Home', 20, [
        { id: 'p1', french: 'Bonjour', english: 'Hello' },
        { id: 'p3', french: 'Bonsoir', english: 'Good evening' },
      ]),
    ])
    h.setLocal(
      library([
        deck('d1', 'Home', 10, [
          { id: 'p1', french: 'Bonjour', english: 'Hello' },
          { id: 'p2', french: 'Merci', english: 'Thanks' },
        ]),
      ]),
    )
    h.engine.syncNow()
    await settle()

    expect(h.local.decks[0]!.phrases.map((p) => p.id)).toEqual(['p1', 'p2', 'p3'])
    expect(server.library!.decks[0]!.phrases.map((p) => p.id)).toEqual(['p1', 'p2', 'p3'])
  })
})

describe('createSyncEngine — the two failures a retry cannot fix', () => {
  it('asks her to sign in again on 401, and stops retrying', async () => {
    const h = createHarness()
    h.server.pushResult = { ok: false, reason: 'unauthorized' }

    h.engine.start()
    await settle()

    expect(h.engine.snapshot().state).toBe('signed-out')
    expect(h.scheduler.pending).toEqual([])
  })

  it('asks for an app update on a 409 stale-client, and stops retrying', async () => {
    const h = createHarness()
    h.server.pushResult = { ok: false, reason: 'stale-client' }

    h.engine.start()
    await settle()

    expect(h.engine.snapshot().state).toBe('needs-update')
    expect(h.scheduler.pending).toEqual([])
  })

  it('reports an unreadable server envelope as needing an update, never as a lost library', async () => {
    const fromTheFuture: Library = { ...library([deck('d1', 'Home')]), schemaVersion: CURRENT_SCHEMA_VERSION + 99 }
    const server = createFakeServer(fromTheFuture)
    const h = createHarness({ local: library([]), server })

    h.engine.start()
    await settle()

    expect(h.engine.snapshot().state).toBe('needs-update')
    expect(server.pushes).toEqual([])
  })
})
