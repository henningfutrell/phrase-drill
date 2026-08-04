// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { Readable, Writable } from 'node:stream'
import { readPasswordFrom } from './useradd.mjs'

/**
 * T055: `scripts/useradd.mjs` hung in Render's web Shell. Two causes, both
 * pinned here:
 *
 *   1. It printed no prompt, so a silent wait on stdin was indistinguishable
 *      from a crashed process.
 *   2. It resolved on readline's `close` event — i.e. only on EOF (Ctrl-D) —
 *      so pressing Enter did nothing. Render's web terminal does not reliably
 *      deliver Ctrl-D, and where it does it can close the session instead.
 *
 * The password must therefore arrive on the FIRST newline, with a visible
 * prompt written before the read starts.
 */

/** A stream that emits `chunks` and then STAYS OPEN — the Render Shell case: Enter is pressed, EOF never arrives. */
function neverEndingInput(chunks) {
  const stream = new Readable({ read() {} })
  for (const chunk of chunks) stream.push(chunk)
  // deliberately no stream.push(null): no EOF, ever
  return stream
}

function collectingOutput() {
  const written = []
  const stream = new Writable({
    write(chunk, _enc, cb) {
      written.push(chunk.toString())
      cb()
    },
  })
  stream.written = written
  return stream
}

describe('readPasswordFrom', () => {
  it('resolves on the first newline, without waiting for EOF', async () => {
    const input = neverEndingInput(['hunter2\n'])
    const output = collectingOutput()
    await expect(readPasswordFrom({ input, output })).resolves.toBe('hunter2')
  })

  it('writes a prompt before reading, so a wait never looks like a hang', async () => {
    const input = neverEndingInput(['hunter2\n'])
    const output = collectingOutput()
    await readPasswordFrom({ input, output })
    expect(output.written.join('')).toMatch(/password/i)
  })

  it('takes only the first line when more follows', async () => {
    const input = neverEndingInput(['first\nsecond\n'])
    const output = collectingOutput()
    await expect(readPasswordFrom({ input, output })).resolves.toBe('first')
  })

  it('strips a trailing carriage return, so a CRLF terminal does not hash \\r into the password', async () => {
    const input = neverEndingInput(['hunter2\r\n'])
    const output = collectingOutput()
    await expect(readPasswordFrom({ input, output })).resolves.toBe('hunter2')
  })

  it('still resolves when input is piped and closes immediately (the local `printf | node` case)', async () => {
    const input = Readable.from(['piped-pw\n'])
    const output = collectingOutput()
    await expect(readPasswordFrom({ input, output })).resolves.toBe('piped-pw')
  })

  it('rejects when the stream ends with no line at all', async () => {
    const input = Readable.from([])
    const output = collectingOutput()
    await expect(readPasswordFrom({ input, output })).rejects.toThrow(/no password/i)
  })
})
