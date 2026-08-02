/**
 * Screen Wake Lock (docs/design.md "Hold a Wake Lock for the duration of a
 * Drill and release it on stop" — T001, T019 §4 obligation 5). The screen
 * going dark mid-Drill ends it (audio suspends, the loop can't advance), so
 * the Drill screen holds this for as long as it is playing.
 *
 * Whether `navigator.wakeLock` behaves as the spec describes on iOS Safari —
 * held across a Drill's full run, released cleanly — is unverified here; see
 * T013. This adapter's job is only to never crash when the API is absent or
 * a request/release fails, which iOS versions before 16.4 guarantee it will
 * be.
 */

export interface WakeLockSentinelLike {
  release(): Promise<void>
}

export interface NavigatorWakeLockLike {
  wakeLock?: {
    request(type: 'screen'): Promise<WakeLockSentinelLike>
  }
}

export interface WakeLockPort {
  /** Best-effort: never rejects. A failed or unsupported request is silently a no-op. */
  acquire(): Promise<void>
  /** Best-effort: never rejects, safe to call when nothing is held. */
  release(): Promise<void>
}

/**
 * The IndexedDB-adapter-style factory for `WakeLockPort`, wrapping
 * `navigator.wakeLock`. Takes `navigator` as a parameter (defaulting to the
 * real global) so it is testable without a browser that implements the API.
 */
export function createWakeLockPort(
  nav: NavigatorWakeLockLike = typeof navigator === 'undefined' ? {} : navigator,
): WakeLockPort {
  let sentinel: WakeLockSentinelLike | null = null

  return {
    async acquire(): Promise<void> {
      if (!nav.wakeLock) return
      try {
        sentinel = await nav.wakeLock.request('screen')
      } catch {
        // e.g. NotAllowedError when the document isn't visible — the Drill
        // screen re-tries on the next visible state, never surfaces this.
        sentinel = null
      }
    },

    async release(): Promise<void> {
      const current = sentinel
      sentinel = null
      if (!current) return
      try {
        await current.release()
      } catch {
        // Already released, or the platform rejects a redundant release —
        // either way there is nothing left to hold.
      }
    },
  }
}
