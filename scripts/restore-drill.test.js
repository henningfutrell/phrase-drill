// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { scratchDatabaseName, SCRATCH_DATABASE_PREFIX, parseRestoreArgs, verify, REQUIRED_TABLES, CLIPS_DIGEST_SQL } from './restore-drill.mjs'

const withDefaults = (overrides) => ({
  backupFile: '/tmp/backup.sql.gz',
  libraryKey: null,
  expectSha256: null,
  expectClipsSha256: null,
  keepScratch: false,
  ...overrides,
})

/**
 * Dispatches on the SQL the way `db.test.js`'s own `fakePool` does — the
 * drill's checks are SQL plus a verdict, and the verdict is what needs
 * pinning without a live Postgres.
 */
function fakePool({ tables = REQUIRED_TABLES, clips = [], clipsDigest = null }) {
  return {
    async query(sql) {
      if (sql.includes('information_schema.tables')) return { rows: tables.map((table_name) => ({ table_name })) }
      if (sql.includes('FROM libraries')) return { rows: [{ data: 'library-blob' }] }
      if (sql === CLIPS_DIGEST_SQL) return { rows: [{ digest: clipsDigest, count: String(clips.length) }] }
      if (sql.includes('FROM clips')) return { rows: clips }
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

describe('verify — the clips table (T063 added it after this drill was written)', () => {
  it('requires the clips table, not only users/sessions/libraries', () => {
    // A dump taken before `clips` existed, or one that silently skipped it,
    // restores "cleanly" and loses every clip. The drill must say so.
    expect(REQUIRED_TABLES).toContain('clips')
  })

  it('FAILs when the restored database has no clips table at all', async () => {
    const checks = await verify({ pool: fakePool({ tables: ['users', 'sessions', 'libraries'] }) })
    expect(named(checks, 'table "clips" exists')?.pass).toBe(false)
  })

  it('FAILs when a clip restored as text instead of bytea — the exact bytea failure mode', async () => {
    // `pg` hands a real bytea column back as a Buffer. Anything else means
    // the column round-tripped through a text path and the audio is not the
    // audio any more.
    const checks = await verify({ pool: fakePool({ clips: [{ hash: 'abc', bytes: '\\x00ff' }] }) })
    expect(named(checks, 'clip audio round-trips as binary')?.pass).toBe(false)
  })

  it('PASSes when every clip comes back as a Buffer', async () => {
    const checks = await verify({ pool: fakePool({ clips: [{ hash: 'abc', bytes: Buffer.from([0x00, 0xff]) }] }) })
    expect(named(checks, 'clip audio round-trips as binary')?.pass).toBe(true)
  })

  it('FAILs when the clip digest differs from the pre-backup one', async () => {
    const checks = await verify({
      pool: fakePool({ clips: [{ hash: 'abc', bytes: Buffer.from([0x01]) }], clipsDigest: 'aaaa' }),
      expectClipsSha256: 'bbbb',
    })
    expect(named(checks, 'byte-identical to the pre-backup clip digest')?.pass).toBe(false)
  })

  it('PASSes when the clip digest matches the pre-backup one', async () => {
    const checks = await verify({
      pool: fakePool({ clips: [{ hash: 'abc', bytes: Buffer.from([0x01]) }], clipsDigest: 'aaaa' }),
      expectClipsSha256: 'aaaa',
    })
    expect(named(checks, 'byte-identical to the pre-backup clip digest')?.pass).toBe(true)
  })

  it('reports the clip digest and row count without an expectation, rather than staying silent', async () => {
    const checks = await verify({ pool: fakePool({ clips: [{ hash: 'abc', bytes: Buffer.from([0x01]) }], clipsDigest: 'aaaa' }) })
    const reported = named(checks, 'clip digest')
    expect(reported?.pass).toBe(true)
    expect(reported?.detail).toContain('aaaa')
    expect(reported?.detail).toContain('1')
  })

  it('does not FAIL a database that legitimately has no clips yet', async () => {
    const checks = await verify({ pool: fakePool({ clips: [], clipsDigest: null }) })
    expect(checks.every((c) => c.pass)).toBe(true)
  })
})

describe('parseRestoreArgs — --expect-clips-sha256', () => {
  it('parses --expect-clips-sha256', () => {
    expect(parseRestoreArgs(['/tmp/backup.sql.gz', '--expect-clips-sha256=cafe'])).toEqual(withDefaults({ expectClipsSha256: 'cafe' }))
  })
})
