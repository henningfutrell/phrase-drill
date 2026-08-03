// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createRateLimiter } from './rate-limiter.js'

describe('createRateLimiter', () => {
  it('allows up to capacity requests, then denies', () => {
    let t = 0
    const limiter = createRateLimiter({ capacity: 3, refillMs: 1000, now: () => t })
    expect(limiter.allow('k')).toBe(true)
    expect(limiter.allow('k')).toBe(true)
    expect(limiter.allow('k')).toBe(true)
    expect(limiter.allow('k')).toBe(false)
  })

  it('refills continuously at capacity/refillMs tokens per ms', () => {
    let t = 0
    const limiter = createRateLimiter({ capacity: 2, refillMs: 1000, now: () => t })
    expect(limiter.allow('k')).toBe(true)
    expect(limiter.allow('k')).toBe(true)
    expect(limiter.allow('k')).toBe(false)

    t = 200 // 2 tokens/1000ms * 200ms = 0.4 tokens back: still < 1
    expect(limiter.allow('k')).toBe(false)

    t = 500 // 2 tokens/1000ms * 500ms = 1.0 token back: exactly enough
    expect(limiter.allow('k')).toBe(true)
    expect(limiter.allow('k')).toBe(false)
  })

  it('tracks buckets independently per key', () => {
    let t = 0
    const limiter = createRateLimiter({ capacity: 1, refillMs: 1000, now: () => t })
    expect(limiter.allow('a')).toBe(true)
    expect(limiter.allow('a')).toBe(false)
    expect(limiter.allow('b')).toBe(true)
  })

  it('never exceeds capacity no matter how much time passes', () => {
    let t = 0
    const limiter = createRateLimiter({ capacity: 2, refillMs: 1000, now: () => t })
    t = 1_000_000
    expect(limiter.allow('k')).toBe(true)
    expect(limiter.allow('k')).toBe(true)
    expect(limiter.allow('k')).toBe(false)
  })
})
