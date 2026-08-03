// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { getBearerToken } from './auth.js'

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
