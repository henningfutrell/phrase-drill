import { describe, expect, it, vi } from 'vitest'
import { createWakeLockPort, type NavigatorWakeLockLike } from './wake-lock'

function fakeSentinel() {
  return { release: vi.fn().mockResolvedValue(undefined) }
}

describe('createWakeLockPort', () => {
  it('requests a screen wake lock on acquire()', async () => {
    const sentinel = fakeSentinel()
    const request = vi.fn().mockResolvedValue(sentinel)
    const nav: NavigatorWakeLockLike = { wakeLock: { request } }
    const port = createWakeLockPort(nav)

    await port.acquire()

    expect(request).toHaveBeenCalledWith('screen')
  })

  it('releases the held sentinel on release()', async () => {
    const sentinel = fakeSentinel()
    const nav: NavigatorWakeLockLike = { wakeLock: { request: vi.fn().mockResolvedValue(sentinel) } }
    const port = createWakeLockPort(nav)

    await port.acquire()
    await port.release()

    expect(sentinel.release).toHaveBeenCalledTimes(1)
  })

  it('release() is a no-op when nothing was ever acquired', async () => {
    const nav: NavigatorWakeLockLike = { wakeLock: { request: vi.fn() } }
    const port = createWakeLockPort(nav)

    await expect(port.release()).resolves.toBeUndefined()
  })

  it('release() is a no-op when the API is absent — never crashes', async () => {
    const port = createWakeLockPort({})

    await expect(port.release()).resolves.toBeUndefined()
  })

  it('acquire() does not throw when navigator.wakeLock is absent', async () => {
    const port = createWakeLockPort({})

    await expect(port.acquire()).resolves.toBeUndefined()
  })

  it('acquire() does not throw when request() rejects (e.g. document not visible)', async () => {
    const nav: NavigatorWakeLockLike = {
      wakeLock: { request: vi.fn().mockRejectedValue(new Error('NotAllowedError')) },
    }
    const port = createWakeLockPort(nav)

    await expect(port.acquire()).resolves.toBeUndefined()
  })

  it('release() does not throw when the sentinel itself rejects release()', async () => {
    const sentinel = { release: vi.fn().mockRejectedValue(new Error('already released')) }
    const nav: NavigatorWakeLockLike = { wakeLock: { request: vi.fn().mockResolvedValue(sentinel) } }
    const port = createWakeLockPort(nav)

    await port.acquire()

    await expect(port.release()).resolves.toBeUndefined()
  })

  it('re-acquiring replaces the previously held sentinel', async () => {
    const first = fakeSentinel()
    const second = fakeSentinel()
    const request = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    const nav: NavigatorWakeLockLike = { wakeLock: { request } }
    const port = createWakeLockPort(nav)

    await port.acquire()
    await port.acquire()
    await port.release()

    expect(second.release).toHaveBeenCalledTimes(1)
    expect(first.release).not.toHaveBeenCalled()
  })
})
