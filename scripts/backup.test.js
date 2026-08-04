// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { backupFileName, parseBackupTimestamp, selectExpiredBackups, resolveDestinationDir } from './backup.mjs'

const execFileAsync = promisify(execFile)
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'backup.mjs')

/** Runs the script for real and resolves with its exit code and streams — never throws on a non-zero exit. */
function runScript(env) {
  return execFileAsync(process.execPath, [SCRIPT], { env: { PATH: process.env.PATH, ...env } }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (err) => ({ code: err.code, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }),
  )
}

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

// A backup that fails silently is worse than none. Every failure must reach
// stderr, including the ones that happen before the logger is constructed —
// those used to exit 1 with no output at all, which reads as a clean run to
// anything watching stdout.
describe('the script itself, run for real', () => {
  it('says why it refused an s3:// destination instead of exiting 1 in silence', async () => {
    const { code, stderr } = await runScript({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      BACKUP_DEST: 's3://phrase-drill-backups',
    })
    expect(code).toBe(1)
    expect(stderr).toMatch(/local directory/)
  })

  it('says which required variable was missing', async () => {
    const { code, stderr } = await runScript({ BACKUP_DEST: '/tmp/nowhere' })
    expect(code).toBe(1)
    expect(stderr).toMatch(/DATABASE_URL is required/)
  })
})
