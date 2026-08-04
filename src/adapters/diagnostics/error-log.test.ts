import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetFakeIdb } from '../storage/idb.test-support'

import { createIndexedDbErrorLog, ERROR_LOG_CAP } from './error-log'

describe('createIndexedDbErrorLog', () => {
  beforeEach(() => {
    resetFakeIdb()
    vi.stubGlobal('navigator', { storage: { persist: vi.fn().mockResolvedValue(true) } })
  })

  it('starts empty', async () => {
    const log = createIndexedDbErrorLog({ getSecrets: async () => [] })
    expect(await log.list()).toEqual([])
  })

  it('records an entry and lists it back', async () => {
    const log = createIndexedDbErrorLog({ getSecrets: async () => [] })

    await log.record({ timestamp: 1000, source: 'window.onerror', message: 'Boom' })

    const entries = await log.list()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ timestamp: 1000, source: 'window.onerror', message: 'Boom' })
  })

  it('survives a reload — a second store instance sees what the first wrote', async () => {
    const first = createIndexedDbErrorLog({ getSecrets: async () => [] })
    await first.record({ timestamp: 1, source: 'window.onerror', message: 'one' })

    const second = createIndexedDbErrorLog({ getSecrets: async () => [] })
    expect(await second.list()).toHaveLength(1)
  })

  it('lists entries oldest to newest', async () => {
    const log = createIndexedDbErrorLog({ getSecrets: async () => [] })
    await log.record({ timestamp: 1, source: 'window.onerror', message: 'first' })
    await log.record({ timestamp: 2, source: 'window.onerror', message: 'second' })
    await log.record({ timestamp: 3, source: 'window.onerror', message: 'third' })

    const entries = await log.list()
    expect(entries.map((e) => e.message)).toEqual(['first', 'second', 'third'])
  })

  it(`never grows past the ${ERROR_LOG_CAP}-entry cap — the oldest entries are dropped first`, async () => {
    const log = createIndexedDbErrorLog({ getSecrets: async () => [] })

    for (let i = 0; i < ERROR_LOG_CAP + 5; i++) {
      await log.record({ timestamp: i, source: 'window.onerror', message: `entry-${i}` })
    }

    const entries = await log.list()
    expect(entries).toHaveLength(ERROR_LOG_CAP)
    // The 5 oldest (entry-0..entry-4) were trimmed; the newest ERROR_LOG_CAP survive.
    expect(entries[0]!.message).toBe('entry-5')
    expect(entries[entries.length - 1]!.message).toBe(`entry-${ERROR_LOG_CAP + 4}`)
  })

  it('redacts a known secret out of a message before it is ever persisted', async () => {
    const log = createIndexedDbErrorLog({ getSecrets: async () => ['sk-ant-super-secret'] })

    await log.record({
      timestamp: 1,
      source: 'adapter',
      message: 'request failed with header sk-ant-super-secret attached',
    })

    const entries = await log.list()
    expect(entries[0]!.message).not.toContain('sk-ant-super-secret')
    expect(entries[0]!.message).toContain('[REDACTED]')
  })

  it('redacts against both known keys independently, whichever is present', async () => {
    const log = createIndexedDbErrorLog({ getSecrets: async () => ['sk-ant-one', 'el-two'] })

    await log.record({ timestamp: 1, source: 'adapter', message: 'saw el-two in the response' })

    const entries = await log.list()
    expect(entries[0]!.message).not.toContain('el-two')
  })
})
