// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createShutdown } from './shutdown.js'

/**
 * T088. Render sends SIGTERM on every deploy and every restart. With no
 * handler the default action is to kill the process immediately, so a
 * `PUT /api/library` in flight is cut off — the device gets a dropped
 * connection, and the push carrying whatever she has just written does not
 * land. The device retries, so nothing is lost forever; what a drain buys is
 * that the ordinary case (a deploy) does not depend on the retry working.
 */
function fakeServer() {
  const events = []
  return {
    events,
    closed: false,
    close(callback) {
      events.push('server.close')
      this.closed = true
      setTimeout(() => callback(), 0)
    },
    closeIdleConnections() {
      events.push('server.closeIdleConnections')
    },
    closeAllConnections() {
      events.push('server.closeAllConnections')
    },
  }
}

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

describe('createShutdown (T088)', () => {
  it('stops accepting connections, drains, then ends the pool — in that order', async () => {
    const server = fakeServer()
    const events = server.events
    const pool = { end: vi.fn(async () => void events.push('pool.end')) }
    const logger = fakeLogger()

    await createShutdown({ server, pool, logger, exit: vi.fn() })('SIGTERM')

    expect(events).toEqual(['server.close', 'server.closeIdleConnections', 'pool.end'])
    expect(logger.info).toHaveBeenCalledWith('shutting down', { signal: 'SIGTERM' })
    expect(logger.info).toHaveBeenCalledWith('shutdown complete', { signal: 'SIGTERM' })
  })

  it('ends the pool exactly once when the signal arrives twice', async () => {
    const server = fakeServer()
    const pool = { end: vi.fn(async () => {}) }
    const shutdown = createShutdown({ server, pool, logger: fakeLogger(), exit: vi.fn() })

    await Promise.all([shutdown('SIGTERM'), shutdown('SIGTERM')])
    await shutdown('SIGINT')

    expect(pool.end).toHaveBeenCalledTimes(1)
  })

  it('an errored pool end does not stop the process from exiting cleanly', async () => {
    const server = fakeServer()
    const pool = {
      end: vi.fn(async () => {
        throw new Error('pool already ended')
      }),
    }
    const logger = fakeLogger()

    await expect(createShutdown({ server, pool, logger, exit: vi.fn() })('SIGTERM')).resolves.toBeUndefined()

    expect(logger.error).toHaveBeenCalledWith('shutdown did not complete cleanly', { error: 'pool already ended' })
  })

  it('forces the sockets shut and exits when a request will not drain inside the deadline', async () => {
    vi.useFakeTimers()
    try {
      // A server whose `close` callback never fires: one request is stuck.
      const events = []
      const server = {
        close() {
          events.push('server.close')
        },
        closeIdleConnections() {
          events.push('server.closeIdleConnections')
        },
        closeAllConnections() {
          events.push('server.closeAllConnections')
        },
      }
      const pool = { end: vi.fn(async () => {}) }
      const logger = fakeLogger()
      const exit = vi.fn()

      createShutdown({ server, pool, logger, timeoutMs: 5000, exit })('SIGTERM')
      await vi.advanceTimersByTimeAsync(5000)

      expect(logger.error).toHaveBeenCalledWith('shutdown timed out — forcing the remaining connections shut', { timeoutMs: 5000 })
      expect(events).toContain('server.closeAllConnections')
      expect(exit).toHaveBeenCalledWith(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
