import { describe, expect, it } from 'vitest'
import {
  BACKUP_AGING_AFTER_DAYS,
  BACKUP_OVERDUE_AFTER_DAYS,
  backupAge,
  isBackupUrgent,
  lastBackupAt,
} from './backup-age'

const DAY = 86_400_000
const NOW = 1_800_000_000_000

/** `now` minus `days` whole days, plus an optional extra offset in ms. */
function daysAgo(days: number, extraMs = 0): number {
  return NOW - days * DAY - extraMs
}

describe('lastBackupAt — the more recent of a sync and an export', () => {
  it('is null when neither has ever happened', () => {
    expect(lastBackupAt(null, null)).toBeNull()
  })

  it('is the export time when only an export has happened', () => {
    expect(lastBackupAt(null, 4242)).toBe(4242)
  })

  it('is the sync time when only a sync has happened', () => {
    expect(lastBackupAt(9999, null)).toBe(9999)
  })

  it('is the sync time when the sync is the more recent of the two', () => {
    expect(lastBackupAt(500, 100)).toBe(500)
  })

  it('is the export time when the export is the more recent of the two', () => {
    expect(lastBackupAt(100, 500)).toBe(500)
  })
})

describe('backupAge — how long since the library was last safe somewhere else', () => {
  it("reports 'never' with no elapsed days when nothing has ever been backed up", () => {
    expect(backupAge(null, NOW)).toEqual({ level: 'never', days: 0 })
  })

  it('reports today as zero whole days', () => {
    expect(backupAge(daysAgo(0), NOW)).toEqual({ level: 'fresh', days: 0 })
  })

  it('counts whole elapsed days and rounds down, never up', () => {
    // 7.5 days elapsed is 7 days ago, not 8 — a part-day is not a day.
    expect(backupAge(daysAgo(7, DAY / 2), NOW)).toEqual({ level: 'aging', days: 7 })
  })

  it('reads a timestamp in the future as zero days, not as a negative age', () => {
    // Clock skew between two devices, or a phone whose date was corrected
    // backwards. There is no such thing as a backup made -1 days ago.
    expect(backupAge(NOW + 5 * DAY, NOW)).toEqual({ level: 'fresh', days: 0 })
  })

  it('stays fresh on the last day before the aging threshold', () => {
    expect(backupAge(daysAgo(BACKUP_AGING_AFTER_DAYS - 1), NOW)).toEqual({ level: 'fresh', days: 6 })
  })

  it('turns aging exactly on the aging threshold', () => {
    expect(backupAge(daysAgo(BACKUP_AGING_AFTER_DAYS), NOW)).toEqual({ level: 'aging', days: 7 })
  })

  it('stays aging on the last day before the overdue threshold', () => {
    expect(backupAge(daysAgo(BACKUP_OVERDUE_AFTER_DAYS - 1), NOW)).toEqual({ level: 'aging', days: 29 })
  })

  it('turns overdue exactly on the overdue threshold', () => {
    expect(backupAge(daysAgo(BACKUP_OVERDUE_AFTER_DAYS), NOW)).toEqual({ level: 'overdue', days: 30 })
  })

  it('keeps counting past the overdue threshold rather than capping', () => {
    expect(backupAge(daysAgo(365), NOW)).toEqual({ level: 'overdue', days: 365 })
  })

  it('holds the two thresholds a week and a month apart', () => {
    expect(BACKUP_AGING_AFTER_DAYS).toBe(7)
    expect(BACKUP_OVERDUE_AFTER_DAYS).toBe(30)
  })
})

describe('isBackupUrgent — whether the indicator follows her off the home screen', () => {
  it('is quiet only when the backup is fresh', () => {
    expect(isBackupUrgent({ level: 'fresh', days: 3 })).toBe(false)
  })

  it('is urgent when nothing has ever been backed up', () => {
    expect(isBackupUrgent({ level: 'never', days: 0 })).toBe(true)
  })

  it('is urgent while aging', () => {
    expect(isBackupUrgent({ level: 'aging', days: 12 })).toBe(true)
  })

  it('is urgent when overdue', () => {
    expect(isBackupUrgent({ level: 'overdue', days: 40 })).toBe(true)
  })
})
