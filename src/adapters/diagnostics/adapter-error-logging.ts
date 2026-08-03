import type { ErrorLog } from './error-log'

function describeFailure(err: unknown): string {
  if (err instanceof Error) return err.message
  if (err && typeof err === 'object' && 'kind' in err) return String((err as { kind: unknown }).kind)
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

/**
 * Wraps an adapter call so a failure is logged (tagged with `source`) before
 * being rethrown unchanged — the caller's own error handling is untouched.
 * Applied at the composition root (`main.tsx`) around `synthClient.synthesize`
 * and `scanReader.read`, rather than editing those adapters directly, to
 * capture adapter failures (T039) without scattering logging through
 * heavily-tested files.
 */
export function withAdapterErrorLogging<Args extends unknown[], Result>(
  source: string,
  fn: (...args: Args) => Promise<Result>,
  log: ErrorLog,
  now: () => number = Date.now,
): (...args: Args) => Promise<Result> {
  return async (...args: Args): Promise<Result> => {
    try {
      return await fn(...args)
    } catch (err) {
      void log.record({ timestamp: now(), source: 'adapter', message: `${source}: ${describeFailure(err)}` })
      throw err
    }
  }
}
