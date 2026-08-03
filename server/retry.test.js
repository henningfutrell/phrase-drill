// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { withRetry } from './retry.js'

function quotaError() {
  const err = new Error('quota')
  err.kind = 'quota'
  return err
}

function networkError() {
  const err = new Error('network')
  err.kind = 'network'
  return err
}

describe('withRetry', () => {
  it('returns the result on first success without retrying', async () => {
    const fn = vi.fn().mockResolvedValue('ok')
    const result = await withRetry(fn, { retries: 3, baseMs: 10, isRetryable: () => true, sleep: async () => {} })
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries a retryable failure up to `retries` times then succeeds', async () => {
    const fn = vi.fn().mockRejectedValueOnce(quotaError()).mockRejectedValueOnce(quotaError()).mockResolvedValue('ok')
    const sleep = vi.fn().mockResolvedValue(undefined)
    const result = await withRetry(fn, { retries: 3, baseMs: 10, isRetryable: (e) => e.kind === 'quota', sleep, jitter: () => 1 })
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it('gives up after exceeding `retries` and throws the last error', async () => {
    const fn = vi.fn().mockRejectedValue(quotaError())
    const sleep = vi.fn().mockResolvedValue(undefined)
    await expect(
      withRetry(fn, { retries: 2, baseMs: 10, isRetryable: (e) => e.kind === 'quota', sleep, jitter: () => 1 }),
    ).rejects.toThrow('quota')
    expect(fn).toHaveBeenCalledTimes(3) // initial attempt + 2 retries
  })

  it('does not retry a non-retryable error', async () => {
    const fn = vi.fn().mockRejectedValue(networkError())
    const sleep = vi.fn()
    await expect(
      withRetry(fn, { retries: 3, baseMs: 10, isRetryable: (e) => e.kind === 'quota', sleep }),
    ).rejects.toThrow('network')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('backs off exponentially, scaled by jitter', async () => {
    const fn = vi.fn().mockRejectedValueOnce(quotaError()).mockRejectedValueOnce(quotaError()).mockResolvedValue('ok')
    const delays = []
    const sleep = vi.fn().mockImplementation(async (ms) => {
      delays.push(ms)
    })
    await withRetry(fn, { retries: 3, baseMs: 100, isRetryable: () => true, sleep, jitter: () => 1 })
    expect(delays).toEqual([100, 200])
  })
})
