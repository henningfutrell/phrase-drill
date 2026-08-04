// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { scratchDatabaseName, SCRATCH_DATABASE_PREFIX, parseRestoreArgs } from './restore-drill.mjs'

const withDefaults = (overrides) => ({
  backupFile: '/tmp/backup.sql.gz',
  libraryKey: null,
  expectSha256: null,
  keepScratch: false,
  ...overrides,
})

describe('scratchDatabaseName', () => {
  it('always starts with the scratch prefix, never a name the caller controls', () => {
    const name = scratchDatabaseName()
    expect(name.startsWith(SCRATCH_DATABASE_PREFIX)).toBe(true)
  })

  it('is different every call, so concurrent drills cannot collide', () => {
    expect(scratchDatabaseName()).not.toBe(scratchDatabaseName())
  })

  it('ignores any caller-supplied randomness that would collide with the prefix boundary', () => {
    // the function takes no input at all — there is no argument through
    // which a caller could ever make this resolve to a production db name.
    expect(scratchDatabaseName.length).toBe(0)
  })
})

describe('parseRestoreArgs', () => {
  it('requires a backup file as the first positional argument', () => {
    expect(() => parseRestoreArgs([])).toThrow(/backup file/i)
  })

  it('parses the backup file path with no optional flags', () => {
    expect(parseRestoreArgs(['/tmp/backup.sql.gz'])).toEqual(withDefaults())
  })

  it('parses --library-key and --expect-sha256', () => {
    expect(parseRestoreArgs(['/tmp/backup.sql.gz', '--library-key=abc123', '--expect-sha256=deadbeef'])).toEqual(
      withDefaults({ libraryKey: 'abc123', expectSha256: 'deadbeef' }),
    )
  })

  it('rejects an unrecognized flag rather than silently ignoring it', () => {
    expect(() => parseRestoreArgs(['/tmp/backup.sql.gz', '--bogus=1'])).toThrow(/unrecognized/i)
  })

  it('defaults --keep-scratch to false — the safe path (always drop) needs no flag', () => {
    expect(parseRestoreArgs(['/tmp/backup.sql.gz']).keepScratch).toBe(false)
  })

  it('parses a bare --keep-scratch (no "=value") as true', () => {
    expect(parseRestoreArgs(['/tmp/backup.sql.gz', '--keep-scratch'])).toEqual(withDefaults({ keepScratch: true }))
  })

  it('rejects --keep-scratch=anything — it is a boolean presence flag, not a valued one', () => {
    expect(() => parseRestoreArgs(['/tmp/backup.sql.gz', '--keep-scratch=true'])).toThrow(/--keep-scratch/i)
  })
})
