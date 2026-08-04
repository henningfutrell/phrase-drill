// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { backupFileName, parseBackupTimestamp, selectExpiredBackups, parseDestination, awsArgs } from './backup.mjs'

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

describe('parseDestination', () => {
  it('parses an s3:// destination into bucket and prefix', () => {
    expect(parseDestination('s3://phrase-drill-backups/prod')).toEqual({
      kind: 's3',
      bucket: 'phrase-drill-backups',
      prefix: 'prod',
    })
  })

  it('parses an s3:// destination with no prefix', () => {
    expect(parseDestination('s3://phrase-drill-backups')).toEqual({
      kind: 's3',
      bucket: 'phrase-drill-backups',
      prefix: '',
    })
  })

  it('treats anything else as a local directory', () => {
    expect(parseDestination('/var/backups/phrase-drill')).toEqual({ kind: 'local', dir: '/var/backups/phrase-drill' })
  })
})

describe('awsArgs', () => {
  it('adds nothing when no endpoint or region is configured', () => {
    expect(awsArgs(['s3', 'ls'], {})).toEqual(['s3', 'ls'])
  })

  it('forwards BACKUP_S3_ENDPOINT as --endpoint-url', () => {
    expect(awsArgs(['s3', 'ls'], { BACKUP_S3_ENDPOINT: 'https://s3.us-west-002.backblazeb2.com' })).toEqual([
      's3',
      'ls',
      '--endpoint-url',
      'https://s3.us-west-002.backblazeb2.com',
    ])
  })

  it('forwards BACKUP_S3_REGION as --region — Backblaze B2 needs it explicitly, unlike plain AWS S3', () => {
    expect(awsArgs(['s3', 'ls'], { BACKUP_S3_REGION: 'us-west-002' })).toEqual(['s3', 'ls', '--region', 'us-west-002'])
  })

  it('forwards both, endpoint then region, when both are set', () => {
    expect(
      awsArgs(['s3', 'ls'], {
        BACKUP_S3_ENDPOINT: 'https://s3.us-west-002.backblazeb2.com',
        BACKUP_S3_REGION: 'us-west-002',
      }),
    ).toEqual(['s3', 'ls', '--endpoint-url', 'https://s3.us-west-002.backblazeb2.com', '--region', 'us-west-002'])
  })
})
