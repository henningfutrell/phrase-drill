import { describe, expect, it } from 'vitest'
import { withAdapterErrorLogging } from './adapter-error-logging'
import type { ErrorLog } from './error-log'

function createFakeLog(): ErrorLog & { records: Array<{ timestamp: number; source: string; message: string }> } {
  const records: Array<{ timestamp: number; source: string; message: string }> = []
  return {
    records,
    async record(entry) {
      records.push(entry)
    },
    async list() {
      return []
    },
  }
}

describe('withAdapterErrorLogging', () => {
  it('passes through a successful call untouched, logging nothing', async () => {
    const log = createFakeLog()
    const wrapped = withAdapterErrorLogging('synth', async (x: number) => x * 2, log)

    expect(await wrapped(21)).toBe(42)
    expect(log.records).toHaveLength(0)
  })

  it('logs a failure, tagged with the given source, then rethrows it unchanged', async () => {
    const log = createFakeLog()
    const failure = new Error('network down')
    const wrapped = withAdapterErrorLogging(
      'scan',
      async () => {
        throw failure
      },
      log,
      () => 500,
    )

    await expect(wrapped()).rejects.toBe(failure)
    expect(log.records).toHaveLength(1)
    expect(log.records[0]).toMatchObject({ timestamp: 500, source: 'adapter' })
    expect(log.records[0]!.message).toContain('scan')
    expect(log.records[0]!.message).toContain('network down')
  })

  it('describes a typed port error (kind, no message) by its kind, not [object Object]', async () => {
    const log = createFakeLog()
    const wrapped = withAdapterErrorLogging(
      'synth',
      async () => {
        throw { kind: 'unauthorized' }
      },
      log,
    )

    await expect(wrapped()).rejects.toEqual({ kind: 'unauthorized' })
    expect(log.records[0]!.message).toContain('unauthorized')
    expect(log.records[0]!.message).not.toContain('[object Object]')
  })
})
