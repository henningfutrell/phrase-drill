import { describe, expect, it } from 'vitest'
import { getBuildInfo } from './build-info'

describe('getBuildInfo', () => {
  // The exact SHA/timestamp depend on the checkout this test runs in
  // (vite.config.ts's `define`, computed from `git rev-parse` at build/dev
  // start) — this asserts the *shape* is real build data, not a hand-edited
  // placeholder, not that any particular value is present.
  it('reports a non-empty build sha', () => {
    const info = getBuildInfo()
    expect(typeof info.sha).toBe('string')
    expect(info.sha.length).toBeGreaterThan(0)
  })

  it('reports a build timestamp parseable as a date', () => {
    const info = getBuildInfo()
    expect(typeof info.builtAt).toBe('string')
    expect(Number.isNaN(new Date(info.builtAt).getTime())).toBe(false)
  })
})
