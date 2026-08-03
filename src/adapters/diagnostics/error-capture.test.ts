import { describe, expect, it } from 'vitest'
import { installErrorCapture } from './error-capture'
import type { ErrorLog } from './error-log'

/** Minimal stand-in for `window` — only the two listener methods this
 * adapter actually calls (mirrors idb.test-support.ts's "deliberately
 * minimal" convention for mocking an external seam). */
function createFakeTarget() {
  const listeners = new Map<string, Set<(event: unknown) => void>>()
  return {
    addEventListener(type: string, cb: (event: unknown) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(cb)
    },
    removeEventListener(type: string, cb: (event: unknown) => void) {
      listeners.get(type)?.delete(cb)
    },
    dispatch(type: string, event: unknown) {
      for (const cb of listeners.get(type) ?? []) cb(event)
    },
  }
}

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

describe('installErrorCapture', () => {
  it('captures a window.onerror event into the log', () => {
    const target = createFakeTarget()
    const log = createFakeLog()
    installErrorCapture(log, target as unknown as Window, () => 12345)

    target.dispatch('error', { message: 'Boom', filename: 'app.js', lineno: 10, colno: 2 })

    expect(log.records).toHaveLength(1)
    expect(log.records[0]).toMatchObject({ timestamp: 12345, source: 'window.onerror' })
    expect(log.records[0]!.message).toContain('Boom')
  })

  it('captures an unhandledrejection event into the log', () => {
    const target = createFakeTarget()
    const log = createFakeLog()
    installErrorCapture(log, target as unknown as Window, () => 999)

    target.dispatch('unhandledrejection', { reason: new Error('rejected') })

    expect(log.records).toHaveLength(1)
    expect(log.records[0]).toMatchObject({ timestamp: 999, source: 'unhandledrejection' })
    expect(log.records[0]!.message).toContain('rejected')
  })

  it('describes a non-Error rejection reason without throwing', () => {
    const target = createFakeTarget()
    const log = createFakeLog()
    installErrorCapture(log, target as unknown as Window, () => 1)

    target.dispatch('unhandledrejection', { reason: 'a plain string reason' })

    expect(log.records[0]!.message).toContain('a plain string reason')
  })

  it('returns a cleanup function that stops further capture', () => {
    const target = createFakeTarget()
    const log = createFakeLog()
    const uninstall = installErrorCapture(log, target as unknown as Window, () => 1)

    uninstall()
    target.dispatch('error', { message: 'after cleanup', filename: '', lineno: 0, colno: 0 })

    expect(log.records).toHaveLength(0)
  })
})
