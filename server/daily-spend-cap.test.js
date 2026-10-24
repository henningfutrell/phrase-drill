// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createDailySpendCap } from './daily-spend-cap.js'

const DAY_MS = 24 * 60 * 60 * 1000

describe('createDailySpendCap', () => {
  it('allows up to the limit in one UTC day, then refuses', () => {
    const cap = createDailySpendCap({ limit: 2, now: () => 0 })
    expect(cap.allow('k')).toEqual({ ok: true })
    expect(cap.allow('k')).toEqual({ ok: true })
    expect(cap.allow('k').ok).toBe(false)
  })

  it('counts each key on its own', () => {
    const cap = createDailySpendCap({ limit: 1, now: () => 0 })
    expect(cap.allow('a')).toEqual({ ok: true })
    expect(cap.allow('b')).toEqual({ ok: true })
    expect(cap.allow('a').ok).toBe(false)
  })

  // The device parks a 429 for exactly `Retry-After`, so the wait must be
  // the real one: until the next UTC midnight, when the count starts again.
  it('says how long until the next UTC day when it refuses', () => {
    let t = 10 * DAY_MS + 6 * 60 * 60 * 1000 // 06:00 UTC
    const cap = createDailySpendCap({ limit: 1, now: () => t })
    cap.allow('k')
    expect(cap.allow('k')).toEqual({ ok: false, retryAfterMs: 18 * 60 * 60 * 1000 })

    t = 11 * DAY_MS // midnight: a new day
    expect(cap.allow('k')).toEqual({ ok: true })
  })

  it('does not spend on a refusal', () => {
    let t = 0
    const cap = createDailySpendCap({ limit: 1, now: () => t })
    cap.allow('k')
    cap.allow('k')
    cap.allow('k')
    t = DAY_MS
    expect(cap.allow('k')).toEqual({ ok: true })
    expect(cap.allow('k').ok).toBe(false)
  })
})
