// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { scratchDatabaseName, SCRATCH_DATABASE_PREFIX, parseRestoreArgs, verify, REQUIRED_TABLES } from './restore-drill.mjs'

const withDefaults = (overrides) => ({
  backupFile: '/tmp/backup.sql.gz',
  libraryKey: null,
  expectSha256: null,
  keepScratch: false,
  ...overrides,
})

/**
 * Dispatches on the SQL the way `db.test.js`'s own `fakePool` does — the
 * drill's checks are SQL plus a verdict, and the verdict is what needs
 * pinning without a live Postgres.
 */
function fakePool({ tables = REQUIRED_TABLES }) {
  return {
    async query(sql) {
      if (sql.includes('information_schema.tables')) return { rows: tables.map((table_name) => ({ table_name })) }
      if (sql.includes('FROM libraries')) return { rows: [{ data: 'library-blob' }] }
      throw new Error(`unexpected query: ${sql}`)
    },
  }
}

const named = (checks, fragment) => checks.find((c) => c.name.includes(fragment))

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

describe('verify — required tables', () => {
  it('requires exactly the tables the app owns now: auth and clip bytes live in Supabase, not in the dump', () => {
    expect(REQUIRED_TABLES).toEqual(['libraries', 'library_versions', 'clips'])
  })

  it('passes a restore that has every required table', async () => {
    const checks = await verify({ pool: fakePool({}) })
    expect(checks.every((c) => c.pass)).toBe(true)
  })

  it.each(['libraries', 'library_versions', 'clips'])('FAILs when the restored database has no %s table', async (missing) => {
    const checks = await verify({ pool: fakePool({ tables: REQUIRED_TABLES.filter((t) => t !== missing) }) })
    expect(named(checks, `table "${missing}" exists`)?.pass).toBe(false)
  })

  it('does not ask for the removed users/sessions tables or run any clip-byte check', async () => {
    const checks = await verify({ pool: fakePool({ tables: ['libraries', 'library_versions', 'clips'] }) })
    expect(named(checks, 'users')).toBeUndefined()
    expect(named(checks, 'clip')?.name).toBe('table "clips" exists')
  })
})

describe('parseRestoreArgs — the clip digest flag is gone', () => {
  it('rejects --expect-clips-sha256: clip bytes are not in the dump any more', () => {
    expect(() => parseRestoreArgs(['/tmp/backup.sql.gz', '--expect-clips-sha256=cafe'])).toThrow(/unrecognized/i)
  })
})
