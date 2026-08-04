// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { backupFileName, parseBackupTimestamp, selectExpiredBackups, resolveDestinationDir } from './backup.mjs'

describe('backupFileName', () => {
  it('is ISO-8601 UTC with colons swapped for dashes, so it sorts chronologically and is a safe filename', () => {
    const date = new Date('2026-08-03T14:30:05.123Z')
    expect(backupFileName(date)).toBe('phrase-drill-2026-08-03T14-30-05Z.sql.gz')
  })

  it('two backups taken a second apart sort in the order they were taken', () => {
    const a = backupFileName(new Date('2026-08-03T14:30:05.000Z'))
    const b = backupFileName(new Date('2026-08-03T14:30:06.000Z'))
    expect([b, a].sort()).toEqual([a, b])
  })
})

describe('parseBackupTimestamp', () => {
  it('recovers the timestamp encoded in a backup file name', () => {
    const ts = parseBackupTimestamp('phrase-drill-2026-08-03T14-30-05Z.sql.gz')
    expect(ts?.toISOString()).toBe('2026-08-03T14:30:05.000Z')
  })

  it('returns null for a name that does not match the pattern — never touched by retention', () => {
    expect(parseBackupTimestamp('some-other-file.sql.gz')).toBeNull()
    expect(parseBackupTimestamp('.gitkeep')).toBeNull()
  })
})

describe('selectExpiredBackups', () => {
  const now = new Date('2026-08-03T00:00:00.000Z')

  it('keeps everything inside the retention window', () => {
    const names = [backupFileName(new Date('2026-08-02T00:00:00.000Z'))]
    expect(selectExpiredBackups(names, 180, now)).toEqual([])
  })

  it('expires backups older than the retention window', () => {
    const old = backupFileName(new Date('2025-01-01T00:00:00.000Z'))
    const recent = backupFileName(new Date('2026-08-01T00:00:00.000Z'))
    expect(selectExpiredBackups([old, recent], 180, now)).toEqual([old])
  })

  it('never selects a name it cannot parse as a backup — unrelated files are left alone', () => {
    expect(selectExpiredBackups(['README.md', '.gitkeep'], 0, now)).toEqual([])
  })
})

describe('resolveDestinationDir', () => {
  it('takes a local directory path as-is — the only destination this script has', () => {
    expect(resolveDestinationDir('/var/backups/phrase-drill')).toBe('/var/backups/phrase-drill')
  })

  it('accepts a relative directory path too', () => {
    expect(resolveDestinationDir('./backups')).toBe('./backups')
  })

  it('refuses an s3:// destination loudly rather than writing a directory literally named "s3:"', () => {
    expect(() => resolveDestinationDir('s3://phrase-drill-backups/prod')).toThrow(/s3:\/\//)
  })

  it('refuses any other URI scheme for the same reason', () => {
    expect(() => resolveDestinationDir('https://example.com/backups')).toThrow(/local directory/)
    expect(() => resolveDestinationDir('b2://bucket')).toThrow(/local directory/)
  })
})
