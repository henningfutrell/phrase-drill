/**
 * A per-key token bucket. `capacity` tokens refill continuously over
 * `refillMs` (i.e. the sustained rate is `capacity` requests per
 * `refillMs`, with bursting up to `capacity`). In-memory and per-process —
 * this is a single-container app (T041 "boring and portable"), so there is
 * no distributed store to keep in sync; a restart resets every bucket to
 * full, which is the safe direction to fail in.
 *
 * A denial carries `retryAfterMs`: how long until this bucket has a token
 * again (T035). The caller cannot compute that — it does not know how full
 * the bucket is — and a client that has to guess either hammers or sleeps
 * far longer than it needs to. This number is what turns a 429 from "your
 * work is lost" into "your work is queued".
 */
export function createRateLimiter({ capacity, refillMs, now = Date.now }) {
  const buckets = new Map()
  const msPerToken = refillMs / capacity

  return {
    /**
     * Consumes one token for `bucketKey` if there is one to spend.
     * `{ ok: true }`, or `{ ok: false, retryAfterMs }`.
     */
    allow(bucketKey) {
      const t = now()
      let bucket = buckets.get(bucketKey)
      if (!bucket) {
        bucket = { tokens: capacity, last: t }
        buckets.set(bucketKey, bucket)
      }
      const elapsed = Math.max(0, t - bucket.last)
      // Multiply before dividing: `elapsed / refillMs * capacity` loses the
      // last bit for the exact-refill case (1000/60000*60 is 0.999…), which
      // costs a waiting client a whole extra round trip.
      bucket.tokens = Math.min(capacity, bucket.tokens + (elapsed * capacity) / refillMs)
      bucket.last = t

      if (bucket.tokens >= 1) {
        bucket.tokens -= 1
        return { ok: true }
      }
      return { ok: false, retryAfterMs: Math.ceil((1 - bucket.tokens) * msPerToken) }
    },
  }
}
