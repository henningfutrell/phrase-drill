import { describe, expect, it, vi } from 'vitest'
import { getStorageEstimate } from './storage-estimate'

describe('getStorageEstimate', () => {
  it('reports unsupported honestly when navigator.storage.estimate is unavailable', async () => {
    const result = await getStorageEstimate(undefined)
    expect(result).toEqual({ supported: false })
  })

  it('reports usage and quota when the browser provides both', async () => {
    const storage = { estimate: vi.fn().mockResolvedValue({ usage: 1000, quota: 5000 }) }
    const result = await getStorageEstimate(storage as unknown as StorageManager)
    expect(result).toEqual({ supported: true, usageBytes: 1000, quotaBytes: 5000 })
  })

  it('reports unsupported, never a fabricated zero, when the browser omits usage or quota', async () => {
    const storage = { estimate: vi.fn().mockResolvedValue({}) }
    const result = await getStorageEstimate(storage as unknown as StorageManager)
    expect(result).toEqual({ supported: false })
  })

  it('reports unsupported honestly if estimate() itself rejects', async () => {
    const storage = { estimate: vi.fn().mockRejectedValue(new Error('boom')) }
    const result = await getStorageEstimate(storage as unknown as StorageManager)
    expect(result).toEqual({ supported: false })
  })
})
