import { describe, expect, it } from 'vitest'
import { redactSecrets } from './redact'

describe('redactSecrets', () => {
  it('replaces every occurrence of a known secret with a redaction marker', () => {
    const text = 'fetch failed: Authorization: Bearer sk-ant-super-secret returned 401'
    const result = redactSecrets(text, ['sk-ant-super-secret'])
    expect(result).not.toContain('sk-ant-super-secret')
    expect(result).toContain('[REDACTED]')
  })

  it('redacts every secret in the list independently', () => {
    const text = 'keys were sk-ant-one and el-two, both rejected'
    const result = redactSecrets(text, ['sk-ant-one', 'el-two'])
    expect(result).not.toContain('sk-ant-one')
    expect(result).not.toContain('el-two')
  })

  it('leaves text untouched when no secret is present in it', () => {
    const result = redactSecrets('a plain network error, nothing sensitive', ['sk-ant-one'])
    expect(result).toBe('a plain network error, nothing sensitive')
  })

  it('ignores null/undefined/empty entries in the secrets list rather than corrupting the text', () => {
    const text = 'hello world'
    expect(redactSecrets(text, [null, undefined, ''])).toBe('hello world')
  })

  it('redacts a secret that appears more than once', () => {
    const text = 'sk-ant-dup ... sk-ant-dup'
    const result = redactSecrets(text, ['sk-ant-dup'])
    expect(result).toBe('[REDACTED] ... [REDACTED]')
  })
})
