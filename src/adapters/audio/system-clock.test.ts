import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSystemClock } from './system-clock'

describe('createSystemClock', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves after the given number of ms', async () => {
    const clock = createSystemClock()
    let resolved = false
    void clock.wait(1000).then(() => {
      resolved = true
    })

    await vi.advanceTimersByTimeAsync(999)
    expect(resolved).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    expect(resolved).toBe(true)
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const clock = createSystemClock()
    const controller = new AbortController()
    controller.abort()

    await expect(clock.wait(1000, controller.signal)).rejects.toThrow()
  })

  it('rejects and clears the timer when aborted mid-wait', async () => {
    const clock = createSystemClock()
    const controller = new AbortController()

    const promise = clock.wait(1000, controller.signal)
    await vi.advanceTimersByTimeAsync(500)
    controller.abort()

    await expect(promise).rejects.toThrow()
    expect(vi.getTimerCount()).toBe(0)
  })
})
