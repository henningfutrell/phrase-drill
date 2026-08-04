// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createRateLimiter } from './rate-limiter.js'

describe('createRateLimiter', () => {
  it('allows up to capacity requests, then denies', () => {
    let t = 0
    const limiter = createRateLimiter({ capacity: 3, refillMs: 1000, now: () => t })
    expect(limiter.allow('k')).toEqual({ ok: true })
    expect(limiter.allow('k')).toEqual({ ok: true })
    expect(limiter.allow('k')).toEqual({ ok: true })
    expect(limiter.allow('k').ok).toBe(false)
  })

  // The number a client needs to drain a sweep instead of dying on it
  // (T035): how long until this bucket has a token again. Computed from the
  // bucket itself, so the caller never has to guess or hard-code the
  // server's own capacity/refill.
  it('says how long to wait when it denies', () => {
    let t = 0
    const limiter = createRateLimiter({ capacity: 2, refillMs: 1000, now: () => t })
    limiter.allow('k')
    limiter.allow('k')

    // 2 tokens per 1000ms is one token per 500ms, and the bucket is empty.
    expect(limiter.allow('k')).toEqual({ ok: false, retryAfterMs: 500 })

    t = 200 // 0.4 tokens back: 0.6 to go, i.e. 300ms
    expect(limiter.allow('k')).toEqual({ ok: false, retryAfterMs: 300 })
  })

  it('rounds the wait up, so a client that honours it never wakes a fraction of a millisecond early', () => {
    let t = 0
    const limiter = createRateLimiter({ capacity: 3, refillMs: 1000, now: () => t })
    limiter.allow('k')
    limiter.allow('k')
    limiter.allow('k')

    // one token per 333.33ms
    expect(limiter.allow('k')).toEqual({ ok: false, retryAfterMs: 334 })
  })

  it('refills continuously at capacity/refillMs tokens per ms', () => {
    let t = 0
    const limiter = createRateLimiter({ capacity: 2, refillMs: 1000, now: () => t })
    expect(limiter.allow('k').ok).toBe(true)
    expect(limiter.allow('k').ok).toBe(true)
    expect(limiter.allow('k').ok).toBe(false)

    t = 200 // 2 tokens/1000ms * 200ms = 0.4 tokens back: still < 1
    expect(limiter.allow('k').ok).toBe(false)

    t = 500 // 2 tokens/1000ms * 500ms = 1.0 token back: exactly enough
    expect(limiter.allow('k').ok).toBe(true)
    expect(limiter.allow('k').ok).toBe(false)
  })

  it('tracks buckets independently per key', () => {
    let t = 0
    const limiter = createRateLimiter({ capacity: 1, refillMs: 1000, now: () => t })
    expect(limiter.allow('a').ok).toBe(true)
    expect(limiter.allow('a').ok).toBe(false)
    expect(limiter.allow('b').ok).toBe(true)
  })

  it('never exceeds capacity no matter how much time passes', () => {
    let t = 0
    const limiter = createRateLimiter({ capacity: 2, refillMs: 1000, now: () => t })
    t = 1_000_000
    expect(limiter.allow('k').ok).toBe(true)
    expect(limiter.allow('k').ok).toBe(true)
    expect(limiter.allow('k').ok).toBe(false)
  })
})
