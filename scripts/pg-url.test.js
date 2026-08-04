// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { parsePgUrl, sanitizedUriWithDatabase, uriWithDatabase } from './pg-url.mjs'

describe('parsePgUrl', () => {
  it('extracts the password and database name', () => {
    expect(parsePgUrl('postgres://app:hunter2@postgres:5432/phrase_drill')).toEqual({
      password: 'hunter2',
      database: 'phrase_drill',
    })
  })

  it('decodes a percent-encoded password — PGPASSWORD is compared literally, not URL-decoded', () => {
    expect(parsePgUrl('postgres://app:p%40ss@postgres:5432/phrase_drill').password).toBe('p@ss')
  })

  it('returns an empty password when the URL has none', () => {
    expect(parsePgUrl('postgres://postgres:5432/phrase_drill').password).toBe('')
  })
})

describe('sanitizedUriWithDatabase', () => {
  it('strips the password but keeps host, port, user, and query string', () => {
    const uri = sanitizedUriWithDatabase('postgres://app:hunter2@postgres:5432/phrase_drill?sslmode=require', 'phrase_drill')
    expect(uri).toBe('postgres://app@postgres:5432/phrase_drill?sslmode=require')
    expect(uri).not.toContain('hunter2')
  })

  it('swaps in a different database, leaving everything else untouched', () => {
    const uri = sanitizedUriWithDatabase('postgres://app:hunter2@postgres:5432/phrase_drill', 'phrase_drill_restore_drill_ab12cd34')
    expect(uri).toBe('postgres://app@postgres:5432/phrase_drill_restore_drill_ab12cd34')
  })
})

describe('uriWithDatabase', () => {
  it('keeps the password — for in-process `pg` connections only, never a child-process argument', () => {
    const uri = uriWithDatabase('postgres://app:hunter2@postgres:5432/phrase_drill', 'phrase_drill_restore_drill_ab12cd34')
    expect(uri).toBe('postgres://app:hunter2@postgres:5432/phrase_drill_restore_drill_ab12cd34')
  })
})
