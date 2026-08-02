import { describe, expect, it, vi } from 'vitest'
import { requestPersistence } from './persistence'

describe('requestPersistence', () => {
  it('reports unsupported honestly when navigator.storage.persist is unavailable', async () => {
    const log = vi.fn()
    const result = await requestPersistence(undefined, log)
    expect(result).toEqual({ supported: false, persisted: false })
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/unavailable/))
  })

  it('reports persisted: true when the browser grants durable storage', async () => {
    const log = vi.fn()
    const storage = { persist: vi.fn().mockResolvedValue(true) }
    const result = await requestPersistence(storage as unknown as StorageManager, log)
    expect(result).toEqual({ supported: true, persisted: true })
    expect(log).not.toHaveBeenCalled()
  })

  it('reports persisted: false honestly when the browser declines, never pretending success', async () => {
    const log = vi.fn()
    const storage = { persist: vi.fn().mockResolvedValue(false) }
    const result = await requestPersistence(storage as unknown as StorageManager, log)
    expect(result).toEqual({ supported: true, persisted: false })
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/not granted/))
  })

  it('reports failure honestly if persist() itself rejects', async () => {
    const log = vi.fn()
    const storage = { persist: vi.fn().mockRejectedValue(new Error('boom')) }
    const result = await requestPersistence(storage as unknown as StorageManager, log)
    expect(result).toEqual({ supported: false, persisted: false })
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/failed/))
  })
})
