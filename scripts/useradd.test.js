// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { Readable, Writable } from 'node:stream'
import { readPasswordFrom, describeTarget } from './useradd.mjs'

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

  it('unrefs the input after reading, so the process can exit', async () => {
    // The second half of the Render hang, and the more deceptive one: with the
    // read fixed, the account WAS created and the process then sat there
    // forever, because `process.stdin` stayed referenced and held the event
    // loop open. No "created user" line, dead terminal — indistinguishable
    // from the original bug at the keyboard.
    //
    // Asserting `isPaused()` here would be vacuous: `rl.close()` pauses the
    // stream on its own, so that assertion passes against the BROKEN version.
    // `unref` is the property that actually lets the process exit, so that is
    // what gets pinned. It is optional on a plain Readable, hence the spy
    // rather than a call through.
    const input = neverEndingInput(['hunter2\n'])
    let unrefCalls = 0
    input.unref = () => {
      unrefCalls += 1
    }
    const output = collectingOutput()
    await readPasswordFrom({ input, output })
    expect(unrefCalls).toBe(1)
  })

  it('rejects when the stream ends with no line at all', async () => {
    const input = Readable.from([])
    const output = collectingOutput()
    await expect(readPasswordFrom({ input, output })).rejects.toThrow(/no password/i)
  })
})

describe('describeTarget', () => {
  it('names host, port and database so the operator can see where it is going', () => {
    expect(describeTarget('postgres://u:p@db.example.com:5432/phrase_drill')).toBe('db.example.com:5432/phrase_drill')
  })

  it('never includes the password', () => {
    expect(describeTarget('postgres://u:sup3rs3cret@h:5432/d')).not.toContain('sup3rs3cret')
  })

  it('defaults the port rather than printing an empty one', () => {
    expect(describeTarget('postgres://u:p@h/d')).toBe('h:5432/d')
  })

  it('does not throw on a malformed URL — a bad value must produce a message, not a stack trace', () => {
    expect(describeTarget('not a url')).toBe('(unparseable DATABASE_URL)')
  })
})
