// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { BILLED_CALLS_PER_WINDOW, BILLING_WINDOW_MS, STALE_RUNNING_MS } from './clip-job-store.js'
import { clipJobStoreContract, createMemoryClipJobStore } from './clip-job-store.test-support.js'

/**
 * The in-memory job store the runner and app suites use. The same contract
 * runs against the real SQL in `db.postgres.test.js`; this half keeps the fake
 * honest on every `npm test`, the other half needs a live Postgres.
 */
describe('clip job store contract — in memory', () => {
  clipJobStoreContract(async () => createMemoryClipJobStore())
})

describe('clip job store policy numbers', () => {
  // Pinned because docs/server.md states them and the device's behaviour is
  // tuned around them: two billed calls is one generation plus one retry of a
  // clip that was later lost; 24 h is one day of her practising.
  it('caps billing at two calls per hash per 24 h', () => {
    expect(BILLED_CALLS_PER_WINDOW).toBe(2)
    expect(BILLING_WINDOW_MS).toBe(24 * 60 * 60 * 1000)
  })

  // Longer than the provider's 30 s timeout with room to spare, so a job is
  // only reaped when the instance running it is gone.
  it('treats a job as stale only well past the provider timeout', () => {
    expect(STALE_RUNNING_MS).toBe(120_000)
  })
})
