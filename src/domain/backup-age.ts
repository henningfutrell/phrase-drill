/**
 * How long since her library was last safe somewhere other than this phone,
 * and how loudly the app should say so.
 *
 * Two things count as a backup and they are not interchangeable in origin,
 * only in effect: an automatic push to the server (`Settings.lastSyncAt`) and
 * a file she exported herself (`Settings.lastExportAt`). Either one means a
 * copy of her Decks exists off the device, so the age is measured from
 * whichever happened later.
 *
 * Reporting the *sync* age, not only the export age, is what makes this
 * useful. Sync runs after every save, so in normal life the age is hours old
 * and the indicator is a quiet confirmation. An age that climbs past a week
 * therefore does not mean "she forgot to export" — it means **sync has been
 * failing silently**, which is the one failure this app cannot otherwise
 * show her: every push is fire-and-forget, and a `network` or `unauthorized`
 * result is swallowed by design so a failed push never blocks a local save.
 * The backup age is the only place that failure surfaces.
 *
 * Pure and total: no clock of its own, no I/O — `now` is a parameter, which
 * is what lets every threshold be tested at its exact boundary.
 */

const DAY_MS = 86_400_000

/** A week of practice: the smallest amount of work worth its own warning. */
export const BACKUP_AGING_AFTER_DAYS = 7
/** A month of practice: a loss she would feel for a long time. */
export const BACKUP_OVERDUE_AFTER_DAYS = 30

export type BackupAgeLevel = 'never' | 'fresh' | 'aging' | 'overdue'

export interface BackupAge {
  readonly level: BackupAgeLevel
  /** Whole days elapsed, rounded down. `0` when nothing has ever been backed up. */
  readonly days: number
}

/**
 * The more recent of an automatic sync and a manual export, or `null` when
 * neither has ever happened.
 */
export function lastBackupAt(lastSyncAt: number | null, lastExportAt: number | null): number | null {
  // Filtered rather than guarded one at a time, so `null` never reaches
  // `Math.max` — where it would coerce to 0 and quietly stand in for "the
  // epoch", which is a real timestamp and a wrong answer.
  const times = [lastSyncAt, lastExportAt].filter((at): at is number => at !== null)
  if (times.length === 0) return null
  return Math.max(...times)
}

/**
 * Classify an age. A timestamp in the future — two devices whose clocks
 * disagree, or a phone whose date was corrected backwards — reads as zero
 * days rather than as a negative age: there is no such thing as a backup made
 * -3 days ago, and a negative number on that line would read as a fault in
 * the app rather than a fact about her data.
 */
export function backupAge(at: number | null, now: number): BackupAge {
  if (at === null) return { level: 'never', days: 0 }

  const days = Math.max(0, Math.floor((now - at) / DAY_MS))
  if (days < BACKUP_AGING_AFTER_DAYS) return { level: 'fresh', days }
  if (days < BACKUP_OVERDUE_AFTER_DAYS) return { level: 'aging', days }
  return { level: 'overdue', days }
}

/**
 * Whether the indicator follows her off the home screen.
 *
 * This is the escalation, and it is deliberately an escalation in **reach and
 * tone**, never in frequency. A fresh backup is stated once, on the screen she
 * lands on, and nowhere else. Anything else — aging, overdue, or never backed
 * up at all — also appears on the Deck screen, which is where she creates the
 * very data at risk. Nothing repeats, nothing interrupts, and nothing can be
 * dismissed: a dismiss control is what trains a person to ignore a warning,
 * because dismissing is a reflex that can be built. A line of status has no
 * reflex to build, and it goes quiet on its own the moment a sync or an export
 * succeeds.
 */
export function isBackupUrgent(age: BackupAge): boolean {
  return age.level !== 'fresh'
}
