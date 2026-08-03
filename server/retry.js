/**
 * Bounded retry with exponential backoff and jitter — the other half of the
 * `docs/scale.md` defect: a 429 from the upstream provider used to be
 * terminal, never retried. `isRetryable` decides which failures are worth
 * retrying (a 429 is; a bad key or a malformed request is not).
 */
export async function withRetry(fn, { retries, baseMs, isRetryable, sleep = defaultSleep, jitter = defaultJitter }) {
  let attempt = 0
  for (;;) {
    try {
      return await fn()
    } catch (err) {
      attempt++
      if (attempt > retries || !isRetryable(err)) throw err
      const delay = baseMs * 2 ** (attempt - 1) * jitter()
      await sleep(delay)
    }
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** ±20% jitter around the computed backoff, so a burst of retries doesn't re-collide in lockstep. */
function defaultJitter() {
  return 0.8 + Math.random() * 0.4
}
