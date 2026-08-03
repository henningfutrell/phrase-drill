// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createLogger } from './logger.js'

describe('createLogger', () => {
  it('writes one JSON line per call with level, message, and fields', () => {
    const lines = []
    const logger = createLogger({ write: (l) => lines.push(l) })
    logger.info('hello', { foo: 'bar' })
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0])
    expect(parsed.level).toBe('info')
    expect(parsed.msg).toBe('hello')
    expect(parsed.foo).toBe('bar')
    expect(typeof parsed.ts).toBe('string')
  })

  it('redacts a known secret from the message', () => {
    const lines = []
    const logger = createLogger({ secrets: ['sk-super-secret'], write: (l) => lines.push(l) })
    logger.error('failed calling upstream with key sk-super-secret')
    expect(lines[0]).not.toContain('sk-super-secret')
    expect(lines[0]).toContain('[REDACTED]')
  })

  it('redacts a known secret from field values', () => {
    const lines = []
    const logger = createLogger({ secrets: ['sk-super-secret'], write: (l) => lines.push(l) })
    logger.info('request', { detail: 'auth header was Bearer sk-super-secret' })
    expect(lines[0]).not.toContain('sk-super-secret')
  })

  it('ignores empty or non-string secrets', () => {
    const lines = []
    const logger = createLogger({ secrets: ['', null, undefined], write: (l) => lines.push(l) })
    logger.info('fine')
    expect(JSON.parse(lines[0]).msg).toBe('fine')
  })

  it('does not redact when no secrets are configured', () => {
    const lines = []
    const logger = createLogger({ write: (l) => lines.push(l) })
    logger.info('plain message')
    expect(JSON.parse(lines[0]).msg).toBe('plain message')
  })
})
