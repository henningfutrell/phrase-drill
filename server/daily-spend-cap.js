const DAY_MS = 24 * 60 * 60 * 1000

/**
 * A per-key count of billed provider calls per UTC day, with a ceiling.
 *
 * The rate limiters bound how fast one account can spend; this bounds how
 * much. A stolen or leaked access token at 60 tts a minute is ~86,000
 * generations a day, and nothing else here says no to that. The ceiling is
 * set far above what one person drilling French does, so it only ever
 * refuses abuse or a runaway client.
 *
 * In-memory and per-process, like the rate limiters. A restart resets the
 * counts. That is acceptable here: the Render free plan sleeps only after
 * 15 idle minutes, and a client that keeps spending keeps the process awake.
 *
 * A refusal carries `retryAfterMs` until the next UTC midnight, so the
 * device's 429 handling parks the work until then instead of losing it.
 */
export function createDailySpendCap({ limit, now = Date.now }) {
  const spent = new Map()

  return {
    /** Spends one call for `key` if today's count is under `limit`. `{ ok: true }`, or `{ ok: false, retryAfterMs }`. */
    allow(key) {
      const t = now()
      const day = Math.floor(t / DAY_MS)
      const entry = spent.get(key)
      const count = entry && entry.day === day ? entry.count : 0
      if (count >= limit) return { ok: false, retryAfterMs: (day + 1) * DAY_MS - t }
      spent.set(key, { day, count: count + 1 })
      return { ok: true }
    },
  }
}
