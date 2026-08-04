import { mergeLibraries, type Library } from '../../domain'
import { normalizeLibrary } from '../storage/library'
import type { LibrarySyncClient } from './library-sync-client'

/**
 * What the sync line says, and nothing more. Deliberately five states: every
 * one of them is a different thing for her to do (nothing, nothing, nothing,
 * sign in, update the app), and a state nobody can act on differently is not
 * a state worth showing.
 */
export type SyncState =
  /** Everything on this device is on the server. */
  | 'idle'
  /** A round-trip is running now. */
  | 'syncing'
  /** A local change has not reached the server yet; the engine will try again. */
  | 'waiting'
  /** The server rejected this device's session (401). Only she can fix it. */
  | 'signed-out'
  /** This build is older than the stored library (409). Only an app update fixes it. */
  | 'needs-update'

export interface SyncSnapshot {
  readonly state: SyncState
  /** Epoch ms of the last round-trip the server ACCEPTED. Never set by a failure. */
  readonly lastSyncAt: number | null
  /**
   * Bumped every time the engine replaced the local library with a merge, so
   * the composition root knows to re-read its screens. Not a version of
   * anything stored — just "something arrived from elsewhere".
   */
  readonly libraryRevision: number
}

export interface Scheduler {
  /** Run `fn` after `ms`. The returned function cancels it if it has not run. */
  schedule(fn: () => void, ms: number): () => void
}

/**
 * The two facts about the device this engine reacts to. A port, not a direct
 * `window` read, so a two-device test can go offline and come back without a
 * browser.
 */
export interface PlatformPort {
  isOnline(): boolean
  /** The device regained connectivity. Returns an unsubscribe. */
  onOnline(listener: () => void): () => void
  /** The app is being backgrounded — screen lock, app switch, tab close. */
  onHidden(listener: () => void): () => void
}

export interface SyncBaseline {
  read(): Promise<Library | undefined>
  write(library: Library): Promise<void>
}

export interface SyncEngineDeps {
  client: LibrarySyncClient
  /** The whole local library, as it is on this device right now. */
  readLocal(): Promise<Library>
  /** Replace the whole local library with a merge. */
  writeLocal(library: Library): Promise<void>
  baseline: SyncBaseline
  readLastSyncAt(): Promise<number | null>
  recordSync(timestamp: number): Promise<void>
  now?(): number
  scheduler?: Scheduler
  platform?: PlatformPort
  debounceMs?: number
  /** Backoff between retries, in order; the last entry repeats. */
  retryMs?: readonly number[]
}

export interface SyncEngine {
  /** Attach to the device and sync once. Safe to call again after `stop()`. */
  start(): void
  stop(): void
  /** A local change happened. Debounced and coalesced. */
  requestSync(): void
  /** Sync now, skipping the debounce window. */
  syncNow(): void
  snapshot(): SyncSnapshot
  subscribe(listener: (snapshot: SyncSnapshot) => void): () => void
}

/**
 * Two seconds. A burst of edits — accepting five translated candidates, or
 * fixing a phrase and immediately fixing the next — collapses into one
 * round-trip instead of five, which on a phone is five radio wake-ups saved
 * per burst. It is short enough that the push is already in flight before she
 * has navigated anywhere, and the two cases where two seconds is still too
 * long are both covered without polling: the app being backgrounded flushes
 * the window immediately, and a launch always syncs.
 */
const DEFAULT_DEBOUNCE_MS = 2_000

/**
 * Retry backoff after a round-trip that failed on the network. Starts at five
 * seconds for a brief drop (a lift, a tunnel) and stretches to five minutes,
 * which is where it stays: a device that has been offline for an hour is not
 * helped by asking every minute, and the connection coming back is an event
 * the engine already listens for. Nothing here polls when the last sync
 * succeeded — an idle engine makes no requests at all.
 */
const DEFAULT_RETRY_MS = [5_000, 15_000, 60_000, 300_000] as const

/**
 * Sync she never has to think about (T034): the library goes up after every
 * change and at every launch, catches up by itself after being offline, and
 * says what it is doing.
 *
 * ## The one rule everything else follows from
 *
 * **No path here can discard her work.** Concretely:
 *
 * - A round-trip is read-merge-write, never write. The push carries the merge
 *   of the server copy and this device's, so pushing cannot remove a record
 *   only the server had.
 * - A pull that fails means this device cannot know what it would overwrite,
 *   so it does not push at all. Her change stays local and goes up later.
 * - The merge is written back locally BEFORE the push. If the push then
 *   fails, what came down from the other device is already saved here.
 * - The baseline moves only after the server accepts a push. An unacknowledged
 *   push must never be treated as agreed state.
 * - A failure never reports a sync time. "Nothing happened" is a thing the
 *   sync line is allowed to say; "everything is gone" is not a thing this
 *   engine can cause.
 */
export function createSyncEngine(deps: SyncEngineDeps): SyncEngine {
  const scheduler = deps.scheduler ?? browserScheduler()
  const platform = deps.platform ?? browserPlatform()
  const now = deps.now ?? (() => Date.now())
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const retryMs = deps.retryMs ?? DEFAULT_RETRY_MS

  let snapshot: SyncSnapshot = { state: 'idle', lastSyncAt: null, libraryRevision: 0 }
  const listeners = new Set<(snapshot: SyncSnapshot) => void>()

  let started = false
  let running = false
  /** A change arrived while a round-trip was in flight — sync again after it. */
  let again = false
  let cancelTimer: (() => void) | undefined
  let retries = 0
  let detach: (() => void)[] = []

  function emit(next: Partial<SyncSnapshot>): void {
    snapshot = { ...snapshot, ...next }
    for (const listener of [...listeners]) listener(snapshot)
  }

  function clearTimer(): void {
    cancelTimer?.()
    cancelTimer = undefined
  }

  /**
   * One round-trip. Returns the failure reason rather than throwing, so the
   * caller decides between retrying, stopping, and asking her for something.
   */
  async function roundTrip(): Promise<
    { ok: true } | { ok: false; reason: 'network' | 'unauthorized' | 'stale-client' | 'unreadable' }
  > {
    const pulled = await deps.client.pull()
    if (!pulled.ok && pulled.reason !== 'not-found') return { ok: false, reason: pulled.reason }

    let outgoing: Library
    let local: Library
    try {
      local = normalizeLibrary(await deps.readLocal())
      outgoing = pulled.ok ? mergeLibraries(local, normalizeLibrary(pulled.library), await deps.baseline.read()) : local
    } catch {
      // The only way normalization or the merge refuses is an envelope this
      // build cannot read — one written by a newer build. Her library is
      // untouched; the device needs the newer app.
      return { ok: false, reason: 'unreadable' }
    }

    // Local first: whatever the other device had is saved here before
    // anything is asked of the network again.
    if (!sameLibrary(local, outgoing)) {
      await deps.writeLocal(outgoing)
      emit({ libraryRevision: snapshot.libraryRevision + 1 })
    }

    const pushed = await deps.client.push(outgoing)
    if (!pushed.ok) return { ok: false, reason: pushed.reason }

    await deps.baseline.write(outgoing)
    const at = now()
    await deps.recordSync(at)
    emit({ lastSyncAt: at })
    return { ok: true }
  }

  function scheduleRetry(): void {
    clearTimer()
    // A device that knows it is offline waits for the connection to come
    // back rather than waking the radio on a timer to be told the same
    // thing. `onOnline` is what ends that wait.
    if (!platform.isOnline()) return
    const delay = retryMs[Math.min(retries, retryMs.length - 1)]!
    retries += 1
    cancelTimer = scheduler.schedule(() => {
      cancelTimer = undefined
      void run()
    }, delay)
  }

  function syncNow(): void {
    clearTimer()
    void run()
  }

  async function run(): Promise<void> {
    if (!started) return
    if (running) {
      again = true
      return
    }
    running = true
    emit({ state: 'syncing' })
    try {
      const result = await roundTrip()
      if (result.ok) {
        retries = 0
        emit({ state: 'idle' })
      } else if (result.reason === 'unauthorized') {
        // Retrying cannot mint a session. Say so and stop.
        emit({ state: 'signed-out' })
      } else if (result.reason === 'stale-client' || result.reason === 'unreadable') {
        // Retrying the same build gets the same answer.
        emit({ state: 'needs-update' })
      } else {
        emit({ state: 'waiting' })
        scheduleRetry()
      }
    } finally {
      running = false
    }
    if (again) {
      again = false
      await run()
    }
  }

  return {
    start(): void {
      if (started) return
      started = true
      detach = [
        // Catch up on reconnect — but only when there is something to catch
        // up on. An idle engine coming back onto wifi spends nothing.
        platform.onOnline(() => {
          if (snapshot.state !== 'idle') syncNow()
        }),
        // She locks the phone. Flush the debounce window now rather than
        // leaving the change stranded until the next launch.
        platform.onHidden(() => {
          if (cancelTimer || snapshot.state === 'waiting') syncNow()
        }),
      ]
      void deps.readLastSyncAt().then((lastSyncAt) => {
        // Never overwrite a time this run has already earned.
        if (snapshot.lastSyncAt === null) emit({ lastSyncAt })
      })
      void run()
    },

    stop(): void {
      started = false
      clearTimer()
      for (const off of detach) off()
      detach = []
    },

    requestSync(): void {
      if (!started) return
      // 'signed-out' and 'needs-update' each name something only she can do;
      // a pending change must not paint over them with a state that says
      // "wait and it will fix itself".
      if (snapshot.state === 'idle') emit({ state: 'waiting' })
      clearTimer()
      cancelTimer = scheduler.schedule(() => {
        cancelTimer = undefined
        void run()
      }, debounceMs)
    },

    syncNow,

    snapshot(): SyncSnapshot {
      return snapshot
    },

    subscribe(listener): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/**
 * Are these two libraries the same library? Only used to avoid rewriting
 * IndexedDB and re-rendering when a pull brought nothing new — a false
 * negative costs one redundant write, never data.
 */
function sameLibrary(a: Library, b: Library): boolean {
  return fingerprint(a) === fingerprint(b)
}

function fingerprint(library: Library): string {
  const byId = (x: { id: string }, y: { id: string }) => (x.id < y.id ? -1 : 1)
  return JSON.stringify({
    // Phrase order inside a Deck is hers and is compared as written; the
    // order of the Decks themselves is not, so it is normalized away.
    decks: [...library.decks].sort(byId),
    mixes: [...(library.mixes ?? [])].sort(byId),
    tombstones: [...(library.tombstones ?? [])].sort((x, y) => (`${x.kind}:${x.id}` < `${y.kind}:${y.id}` ? -1 : 1)),
    // The pinned voice too (T067): a merge whose only news is the voice the
    // other device pinned is still news, and leaving it out of this
    // comparison would drop it instead of writing it locally.
    voice: library.voice ?? null,
  })
}

function browserScheduler(): Scheduler {
  return {
    schedule(fn, ms) {
      const handle = setTimeout(fn, ms)
      return () => clearTimeout(handle)
    },
  }
}

/**
 * iOS Safari, which is the only browser this app has to work in. `online` is
 * the reconnect signal; `visibilitychange` to hidden and `pagehide` are the
 * two the platform actually delivers when a phone is locked or the app is
 * swiped away — `beforeunload` is not reliable there.
 */
function browserPlatform(): PlatformPort {
  return {
    isOnline: () => navigator.onLine,
    onOnline(listener) {
      window.addEventListener('online', listener)
      return () => window.removeEventListener('online', listener)
    },
    onHidden(listener) {
      const onVisibility = () => {
        if (document.visibilityState === 'hidden') listener()
      }
      document.addEventListener('visibilitychange', onVisibility)
      window.addEventListener('pagehide', listener)
      return () => {
        document.removeEventListener('visibilitychange', onVisibility)
        window.removeEventListener('pagehide', listener)
      }
    },
  }
}
