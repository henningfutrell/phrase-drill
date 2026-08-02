import type { ClockPort } from '../../domain'

/**
 * `ClockPort` backed by the real `setTimeout`/`clearTimeout` — the
 * production counterpart to `domain/drill-player.test-support.ts`'s
 * `fakeClock`. Rejects on abort (never resolves late), matching what
 * `step-runner.ts` already expects from a Pause step's cancellation.
 */
export function createSystemClock(): ClockPort {
  return {
    wait(ms: number, signal?: AbortSignal): Promise<void> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms)
        const onAbort = () => {
          clearTimeout(timer)
          reject(new Error('aborted'))
        }
        if (signal) {
          if (signal.aborted) onAbort()
          else signal.addEventListener('abort', onAbort, { once: true })
        }
      })
    },
  }
}
