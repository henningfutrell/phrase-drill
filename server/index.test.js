// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { portFrom, DEFAULT_PORT } from './index.js'

/**
 * T088. `Number(env.PORT ?? 8080)` was left in place by T082 on the reasoning
 * that "a bad port fails loudly at `listen`". That is true for exactly half of
 * the bad values and false for the half that matters:
 *
 * - `Number('abc')` is `NaN`, and `server.listen(NaN)` throws
 *   `options.port should be >= 0 and < 65536` — loud, as claimed.
 * - `Number('')` is `0` — and `server.listen(0)` is not an error, it is the
 *   documented way to ask the OS for a RANDOM FREE PORT. An empty or
 *   whitespace `PORT` (a cleared field in the Render dashboard, a blank line
 *   in an env file) therefore produces a process that boots, logs "server
 *   listening", passes no health check and answers nothing on the port the
 *   platform routes to. The only off-device copy of her library is then
 *   unreachable, with nothing in the log saying why.
 *
 * Same shape and same fix as `clipStoreMaxBytesFrom` (T082): parse it, fall
 * back to the documented default loudly rather than refusing to boot — a
 * misconfigured deploy that still serves `GET /api/library` is worth more than
 * one that does not start.
 */
describe('portFrom (T088)', () => {
  const newLogger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })

  it('defaults when PORT is not set at all', () => {
    const logger = newLogger()
    expect(portFrom(undefined, logger)).toBe(DEFAULT_PORT)
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('reads a normal port', () => {
    const logger = newLogger()
    expect(portFrom('3000', logger)).toBe(3000)
    expect(portFrom(10000, logger)).toBe(10000)
    expect(logger.error).not.toHaveBeenCalled()
  })

  it.each([
    ['', 'an empty value — Number("") is 0, and listen(0) binds a RANDOM port'],
    [' ', 'whitespace, which Number() also reads as 0'],
    ['0', 'an explicit zero'],
  ])('falls back loudly for %j (%s) rather than binding a random port', (raw) => {
    const logger = newLogger()

    expect(portFrom(raw, logger)).toBe(DEFAULT_PORT)
    expect(logger.error).toHaveBeenCalledWith('PORT is not a usable TCP port — using the default', {
      provided: String(raw),
      using: DEFAULT_PORT,
    })
  })

  it.each([['abc'], ['8080abc'], ['80.5'], ['70000'], ['-1']])('falls back loudly for %j', (raw) => {
    const logger = newLogger()

    expect(portFrom(raw, logger)).toBe(DEFAULT_PORT)
    expect(logger.error).toHaveBeenCalledTimes(1)
  })
})
