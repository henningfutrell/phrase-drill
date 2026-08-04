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
  /**
   * Merge into the local library, reading and writing as one indivisible step
   * (T074) — `update` is applied to what is stored at the instant of the
   * write, never to a snapshot read earlier. `changed` says whether anything
   * was actually written.
   */
  updateLocal(update: (stored: Library) => Library): Promise<{ library: Library; changed: boolean }>
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
 * - The local read and the local write are ONE step (T074). She is holding
 *   the phone and a round-trip is not instant, so anything else would compute
 *   a merge from a snapshot that predates her last keystroke and then write it
 *   over her.
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
    for (const listener of [...listeners]) {
      try {
        listener(snapshot)
      } catch {
        // A subscriber is a screen. A screen that fails to render is that
        // screen's problem; it must not be able to stop the engine that is
        // getting her phrases off this phone.
      }
    }
  }

  function clearTimer(): void {
    cancelTimer?.()
    cancelTimer = undefined
  }

  /**
   * One round-trip. **Returns** every failure, including the ones its
   * dependencies raise by throwing — a rejected promise here would leave the
   * engine at 'syncing' with nothing scheduled to end it, which reads as
   * working while nothing leaves the phone (T069). Every await below is
   * therefore inside a `try`, and each one maps to the state the engine
   * already understands.
   */
  async function roundTrip(): Promise<
    { ok: true } | { ok: false; reason: 'network' | 'unauthorized' | 'stale-client' | 'unreadable' | 'device-storage' }
  > {
    let pulled: Awaited<ReturnType<LibrarySyncClient['pull']>>
    try {
      pulled = await deps.client.pull()
    } catch {
      return { ok: false, reason: 'network' }
    }
    if (!pulled.ok && pulled.reason !== 'not-found') return { ok: false, reason: pulled.reason }

    let remote: Library | undefined
    try {
      remote = pulled.ok ? normalizeLibrary(pulled.library) : undefined
    } catch {
      // The only way normalization refuses is an envelope this build cannot
      // read — one written by a newer build. Her library is untouched; the
      // device needs the newer app.
      return { ok: false, reason: 'unreadable' }
    }

    // Read for storage reasons only — a quota, an aborted transaction, a
    // connection iOS killed — none of which an app update fixes, so they are
    // retryable and must not be confused with an unreadable envelope. The
    // baseline is written by this engine and by nothing else, so reading it
    // outside the merge below races with nobody.
    let baseline: Library | undefined
    try {
      baseline = await deps.baseline.read()
    } catch {
      return { ok: false, reason: 'device-storage' }
    }

    // Local first, and as ONE step: whatever the other device had is saved
    // here before anything is asked of the network again, and the merge is
    // computed from what is stored at the instant it is written rather than
    // from a snapshot read earlier (T074). Anything she saved while this
    // round-trip was in flight is therefore merged in — it was never read
    // early enough to be computed away.
    //
    // A merge that could not be saved here is also not pushed: the push is
    // what moves the baseline, and a baseline for state this device does not
    // hold is a lie the next merge would act on.
    let outgoing: Library
    let refused = false
    try {
      const written = await deps.updateLocal((stored) => {
        try {
          const local = normalizeLibrary(stored)
          return remote ? mergeLibraries(local, remote, baseline) : local
        } catch (error) {
          // Normalization or the merge refusing is an envelope this build
          // cannot read, which is not the same failure as a device that could
          // not write. Both arrive here as a rejection, so which one it was is
          // carried out by hand.
          refused = true
          throw error
        }
      })
      outgoing = written.library
      if (written.changed) emit({ libraryRevision: snapshot.libraryRevision + 1 })
    } catch {
      return { ok: false, reason: refused ? 'unreadable' : 'device-storage' }
    }

    let pushed: Awaited<ReturnType<LibrarySyncClient['push']>>
    try {
      pushed = await deps.client.push(outgoing)
    } catch {
      return { ok: false, reason: 'network' }
    }
    if (!pushed.ok) return { ok: false, reason: pushed.reason }

    // The server has it. If the two bookkeeping writes below fail, the sync
    // itself really happened — but a sync time this device could not record
    // is not a sync time it may claim, so this reports a failure and retries.
    // The retry re-merges against a stale baseline, which costs precision and
    // never a Phrase.
    const at = now()
    try {
      await deps.baseline.write(outgoing)
      await deps.recordSync(at)
    } catch {
      return { ok: false, reason: 'device-storage' }
    }
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
    try {
      emit({ state: 'syncing' })
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
        // 'network' and 'device-storage': both are conditions that pass. Say
        // her work is safe here, and try again.
        emit({ state: 'waiting' })
        scheduleRetry()
      }
    } catch {
      // `roundTrip` is written to return every failure, so reaching this is a
      // fault in the engine itself. It is caught anyway: the one outcome that
      // must be impossible is an engine that stops without scheduling
      // anything, because that is silent and permanent.
      emit({ state: 'waiting' })
      scheduleRetry()
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
      void deps.readLastSyncAt().then(
        (lastSyncAt) => {
          // Never overwrite a time this run has already earned.
          if (snapshot.lastSyncAt === null) emit({ lastSyncAt })
        },
        () => {
          // Not knowing when the last sync was costs one line of text. It is
          // not a reason to leave a rejection unhandled, and not a reason to
          // stop the round-trip that is starting below.
        },
      )
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
