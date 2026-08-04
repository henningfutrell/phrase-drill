import { describe, expect, it, vi } from 'vitest'
import { shareBackupFile } from './web-share'

function makeFile(): File {
  return new File(['{}'], 'phrase-drill-backup-2026-08-02.json', { type: 'application/json' })
}

describe('shareBackupFile', () => {
  it('shares the file through navigator.share when the platform supports file sharing', async () => {
    const share = vi.fn().mockResolvedValue(undefined)
    const canShare = vi.fn().mockReturnValue(true)
    const file = makeFile()

    const result = await shareBackupFile(file, { canShare, share })

    expect(canShare).toHaveBeenCalledWith({ files: [file] })
    expect(share).toHaveBeenCalledWith({ files: [file] })
    expect(result).toBe('shared')
  })

  it('reports unsupported, without calling share, when canShare rejects the file', async () => {
    const share = vi.fn()
    const canShare = vi.fn().mockReturnValue(false)

    const result = await shareBackupFile(makeFile(), { canShare, share })

    expect(share).not.toHaveBeenCalled()
    expect(result).toBe('unsupported')
  })

  it('reports unsupported when the navigator has no canShare/share at all (desktop browsers, old iOS)', async () => {
    const result = await shareBackupFile(makeFile(), {})
    expect(result).toBe('unsupported')
  })

  it('reports cancelled, not an error, when the person dismisses the iOS share sheet', async () => {
    const abortError = new DOMException('cancelled', 'AbortError')
    const share = vi.fn().mockRejectedValue(abortError)
    const canShare = vi.fn().mockReturnValue(true)

    const result = await shareBackupFile(makeFile(), { canShare, share })

    expect(result).toBe('cancelled')
  })

  it('reports unsupported, not a thrown error, when share() rejects for any other reason', async () => {
    const share = vi.fn().mockRejectedValue(new Error('NotAllowedError'))
    const canShare = vi.fn().mockReturnValue(true)

    const result = await shareBackupFile(makeFile(), { canShare, share })

    expect(result).toBe('unsupported')
  })

  it('defaults to the real global navigator when none is injected', async () => {
    vi.stubGlobal('navigator', {})
    const result = await shareBackupFile(makeFile())
    expect(result).toBe('unsupported')
    vi.unstubAllGlobals()
  })

  it('calls share() synchronously, before yielding to the microtask queue', async () => {
    // WebKit expires transient activation across an await
    // (webkit.org/blog/13862/the-user-activation-api/), so nothing in this
    // adapter may sit between the caller's click handler and share().
    const share = vi.fn().mockResolvedValue(undefined)
    const canShare = vi.fn().mockReturnValue(true)

    const pending = shareBackupFile(makeFile(), { canShare, share })

    expect(share).toHaveBeenCalledTimes(1)
    await pending
  })

  it('shares the file alone, with no title, text or url alongside it', async () => {
    // WebKit 251500/316518: a files payload mixed with other members is where
    // iOS share failures cluster.
    const share = vi.fn().mockResolvedValue(undefined)
    const canShare = vi.fn().mockReturnValue(true)
    const file = makeFile()

    await shareBackupFile(file, { canShare, share })

    expect(share).toHaveBeenCalledWith({ files: [file] })
    expect(Object.keys(share.mock.calls[0]![0]!)).toEqual(['files'])
  })
})
