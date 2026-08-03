/**
 * A per-key token bucket. `capacity` tokens refill continuously over
 * `refillMs` (i.e. the sustained rate is `capacity` requests per
 * `refillMs`, with bursting up to `capacity`). In-memory and per-process —
 * this is a single-container app (T041 "boring and portable"), so there is
 * no distributed store to keep in sync; a restart resets every bucket to
 * full, which is the safe direction to fail in.
 */
export function createRateLimiter({ capacity, refillMs, now = Date.now }) {
  const buckets = new Map()

  return {
    /** Returns `true` and consumes one token if `bucketKey` has one to spend. */
    allow(bucketKey) {
      const t = now()
      let bucket = buckets.get(bucketKey)
      if (!bucket) {
        bucket = { tokens: capacity, last: t }
        buckets.set(bucketKey, bucket)
      }
      const elapsed = Math.max(0, t - bucket.last)
      bucket.tokens = Math.min(capacity, bucket.tokens + (elapsed / refillMs) * capacity)
      bucket.last = t

      if (bucket.tokens >= 1) {
        bucket.tokens -= 1
        return true
      }
      return false
    },
  }
}
