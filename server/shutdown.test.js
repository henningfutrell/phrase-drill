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

/**
 * The clip job runner (S5): its `stop()` answers waiting requests and then
 * waits for the provider calls already in flight, which still need the pool.
 */
function fakeRunner(events = [], { finishesAfterMs = 0 } = {}) {
  return {
    stop: vi.fn(async () => {
      events.push('runner.stop')
      await new Promise((resolve) => setTimeout(resolve, finishesAfterMs))
      events.push('runner.stopped')
    }),
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

    await createShutdown({ server, pool, logger, runner: fakeRunner(events), exit: vi.fn() })('SIGTERM')

    expect(events).toEqual(['runner.stop', 'server.close', 'server.closeIdleConnections', 'runner.stopped', 'pool.end'])
    expect(logger.info).toHaveBeenCalledWith('shutting down', { signal: 'SIGTERM' })
    expect(logger.info).toHaveBeenCalledWith('shutdown complete', { signal: 'SIGTERM' })
  })

  it('ends the pool exactly once when the signal arrives twice', async () => {
    const server = fakeServer()
    const pool = { end: vi.fn(async () => {}) }
    const runner = fakeRunner()
    const shutdown = createShutdown({ server, pool, logger: fakeLogger(), runner, exit: vi.fn() })

    await Promise.all([shutdown('SIGTERM'), shutdown('SIGTERM')])
    await shutdown('SIGINT')

    expect(pool.end).toHaveBeenCalledTimes(1)
    expect(runner.stop).toHaveBeenCalledTimes(1)
  })

  // A paid generation in flight at SIGTERM writes its clip and its job row
  // through the pool; ending the pool first would throw the clip away.
  it('waits for the clip runner to finish its calls before ending the pool', async () => {
    const server = fakeServer()
    const events = server.events
    const pool = { end: vi.fn(async () => void events.push('pool.end')) }

    await createShutdown({ server, pool, logger: fakeLogger(), runner: fakeRunner(events, { finishesAfterMs: 20 }), exit: vi.fn() })('SIGTERM')

    expect(events.indexOf('runner.stopped')).toBeLessThan(events.indexOf('pool.end'))
    expect(events.indexOf('server.close'), 'the HTTP drain runs alongside, not after').toBeLessThan(events.indexOf('runner.stopped'))
  })

  it('an errored pool end does not stop the process from exiting cleanly', async () => {
    const server = fakeServer()
    const pool = {
      end: vi.fn(async () => {
        throw new Error('pool already ended')
      }),
    }
    const logger = fakeLogger()

    await expect(createShutdown({ server, pool, logger, runner: fakeRunner(), exit: vi.fn() })('SIGTERM')).resolves.toBeUndefined()

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

      createShutdown({ server, pool, logger, runner: { stop: async () => {} }, timeoutMs: 5000, exit })('SIGTERM')
      await vi.advanceTimersByTimeAsync(5000)

      expect(logger.error).toHaveBeenCalledWith('shutdown timed out — forcing the remaining connections shut', { timeoutMs: 5000 })
      expect(events).toContain('server.closeAllConnections')
      expect(exit).toHaveBeenCalledWith(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
