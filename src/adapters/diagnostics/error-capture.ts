import type { ErrorLog } from './error-log'

/** Minimal surface this adapter needs from `window` — mirrors
 * `idb.test-support.ts`'s "deliberately minimal" convention for mocking an
 * external seam. */
export interface CaptureTarget {
  addEventListener(type: string, listener: (event: unknown) => void): void
  removeEventListener(type: string, listener: (event: unknown) => void): void
}

function describeRejectionReason(reason: unknown): string {
  if (reason instanceof Error) return reason.stack ?? reason.message
  if (typeof reason === 'string') return reason
  try {
    return JSON.stringify(reason)
  } catch {
    return String(reason)
  }
}

/**
 * Installs the two global error hooks T039 asks for — `window.onerror` and
 * `unhandledrejection` — writing each into the injected `ErrorLog`. Lives at
 * the composition root (`main.tsx`), not scattered through components, so
 * every uncaught error anywhere in the app is captured from one place.
 * Returns a cleanup function that removes both listeners.
 */
export function installErrorCapture(
  log: ErrorLog,
  target: CaptureTarget = globalThis.window,
  now: () => number = Date.now,
): () => void {
  function onError(event: unknown): void {
    const e = event as { message?: string; filename?: string; lineno?: number; colno?: number }
    const message = `${e.message ?? 'unknown error'} (${e.filename ?? ''}:${e.lineno ?? 0}:${e.colno ?? 0})`
    void log.record({ timestamp: now(), source: 'window.onerror', message })
  }

  function onRejection(event: unknown): void {
    const e = event as { reason?: unknown }
    void log.record({ timestamp: now(), source: 'unhandledrejection', message: describeRejectionReason(e.reason) })
  }

  target.addEventListener('error', onError)
  target.addEventListener('unhandledrejection', onRejection)

  return () => {
    target.removeEventListener('error', onError)
    target.removeEventListener('unhandledrejection', onRejection)
  }
}
