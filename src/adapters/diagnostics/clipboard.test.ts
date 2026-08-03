import { describe, expect, it, vi } from 'vitest'
import { copyText } from './clipboard'

describe('copyText', () => {
  it('reports success once the Clipboard API resolves', async () => {
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) }
    const ok = await copyText('report text', clipboard)
    expect(ok).toBe(true)
    expect(clipboard.writeText).toHaveBeenCalledWith('report text')
  })

  it('reports failure honestly when the Clipboard API is unavailable', async () => {
    const ok = await copyText('report text', undefined)
    expect(ok).toBe(false)
  })

  it('reports failure honestly when writeText rejects, never throwing', async () => {
    const clipboard = { writeText: vi.fn().mockRejectedValue(new Error('denied')) }
    const ok = await copyText('report text', clipboard)
    expect(ok).toBe(false)
  })
})
