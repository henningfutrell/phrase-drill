// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { CURRENT_SCHEMA_VERSION } from '../src/adapters/storage/migrations'
import { LIBRARY_FORMAT } from '../src/domain'
import { isValidLibraryKey, MAX_LIBRARY_BYTES, parseLibraryEnvelope } from './contract'

describe('isValidLibraryKey', () => {
  it('accepts a high-entropy URL-safe key of a plausible generated length', () => {
    expect(isValidLibraryKey('a'.repeat(43))).toBe(true)
    expect(isValidLibraryKey('AbC-9_xyz0123456')).toBe(true)
  })

  it('rejects keys that are too short to be device-generated entropy', () => {
    expect(isValidLibraryKey('short')).toBe(false)
    expect(isValidLibraryKey('')).toBe(false)
  })

  it('rejects characters outside the URL-safe set', () => {
    expect(isValidLibraryKey('a'.repeat(20) + '/../etc/passwd')).toBe(false)
    expect(isValidLibraryKey('a'.repeat(20) + ' ')).toBe(false)
    expect(isValidLibraryKey('a'.repeat(20) + '+')).toBe(false)
  })

  it('rejects an implausibly long key', () => {
    expect(isValidLibraryKey('a'.repeat(200))).toBe(false)
  })
})

describe('parseLibraryEnvelope', () => {
  const valid = JSON.stringify({
    format: LIBRARY_FORMAT,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    exportedAt: 1,
    decks: [],
  })

  it('accepts a well-formed envelope at the current schema version', () => {
    const result = parseLibraryEnvelope(valid)
    expect(result.ok).toBe(true)
  })

  it('rejects text that is not JSON', () => {
    const result = parseLibraryEnvelope('not json{')
    expect(result).toEqual({ ok: false, error: { kind: 'not-json' } })
  })

  it('rejects a JSON value that is not an object', () => {
    expect(parseLibraryEnvelope('[]')).toEqual({ ok: false, error: { kind: 'invalid' } })
    expect(parseLibraryEnvelope('"hi"')).toEqual({ ok: false, error: { kind: 'invalid' } })
    expect(parseLibraryEnvelope('null')).toEqual({ ok: false, error: { kind: 'invalid' } })
  })

  it('rejects an object missing schemaVersion or decks', () => {
    expect(parseLibraryEnvelope(JSON.stringify({ format: LIBRARY_FORMAT }))).toEqual({
      ok: false,
      error: { kind: 'invalid' },
    })
  })

  it('rejects the wrong format tag', () => {
    expect(
      parseLibraryEnvelope(JSON.stringify({ format: 'something-else', schemaVersion: 1, decks: [] })),
    ).toEqual({ ok: false, error: { kind: 'wrong-format' } })
  })

  it('rejects a schemaVersion newer than this server understands', () => {
    const future = JSON.stringify({
      format: LIBRARY_FORMAT,
      schemaVersion: CURRENT_SCHEMA_VERSION + 1,
      decks: [],
    })
    expect(parseLibraryEnvelope(future)).toEqual({
      ok: false,
      error: { kind: 'schema-version-too-new', serverSchemaVersion: CURRENT_SCHEMA_VERSION },
    })
  })
})

describe('MAX_LIBRARY_BYTES', () => {
  it('is generous relative to a multi-thousand-phrase export but not unbounded', () => {
    expect(MAX_LIBRARY_BYTES).toBeGreaterThan(1024 * 1024)
    expect(MAX_LIBRARY_BYTES).toBeLessThanOrEqual(64 * 1024 * 1024)
  })
})
