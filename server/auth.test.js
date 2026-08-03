// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { getBearerToken, isValidLibraryKey } from './auth.js'

describe('isValidLibraryKey', () => {
  it('accepts 64 lowercase hex characters', () => {
    expect(isValidLibraryKey('a'.repeat(64))).toBe(true)
    expect(isValidLibraryKey('0123456789abcdef'.repeat(4))).toBe(true)
  })

  it('rejects wrong length', () => {
    expect(isValidLibraryKey('a'.repeat(63))).toBe(false)
    expect(isValidLibraryKey('a'.repeat(65))).toBe(false)
  })

  it('rejects uppercase or non-hex characters', () => {
    expect(isValidLibraryKey('A'.repeat(64))).toBe(false)
    expect(isValidLibraryKey('g'.repeat(64))).toBe(false)
  })

  it('rejects non-string input', () => {
    expect(isValidLibraryKey(null)).toBe(false)
    expect(isValidLibraryKey(undefined)).toBe(false)
    expect(isValidLibraryKey(12345)).toBe(false)
  })
})

describe('getBearerToken', () => {
  it('extracts the token from an Authorization header', () => {
    const req = { headers: { authorization: 'Bearer abc123' } }
    expect(getBearerToken(req)).toBe('abc123')
  })

  it('returns null when there is no Authorization header', () => {
    expect(getBearerToken({ headers: {} })).toBeNull()
  })

  it('returns null for a non-Bearer scheme', () => {
    expect(getBearerToken({ headers: { authorization: 'Basic xyz' } })).toBeNull()
  })

  it('returns null for an empty Bearer token', () => {
    expect(getBearerToken({ headers: { authorization: 'Bearer ' } })).toBeNull()
    expect(getBearerToken({ headers: { authorization: 'Bearer    ' } })).toBeNull()
  })
})
