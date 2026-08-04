import type { SyncState } from '../adapters/sync/sync-engine'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * The one line the Decks screen shows about sync (T034). Pure: it takes the
 * engine's snapshot and the current time and returns text.
 *
 * Two rules it never breaks:
 *
 * - **A failure never reads as a success.** Only `lastSyncAt` — set by the
 *   engine when the server accepted a push, and by nothing else — produces
 *   the word "Synced".
 * - **Every failure says her phrases are still here.** The owner has been
 *   burned by "everything is gone"; "Saved on this phone" is the first thing
 *   she reads on every state that is not a completed sync, before anything
 *   about what went wrong.
 */
export function syncStatusText(
  snapshot: { readonly state: SyncState; readonly lastSyncAt: number | null },
  now: number,
): string {
  const last = snapshot.lastSyncAt === null ? 'not synced yet' : `last synced ${age(snapshot.lastSyncAt, now)}`
  switch (snapshot.state) {
    case 'syncing':
      return 'Syncing…'
    case 'waiting':
      return `Saved on this phone · will sync when back online · ${last}`
    case 'signed-out':
      return 'Saved on this phone · sign in again to sync'
    case 'needs-update':
      return 'Saved on this phone · update the app to sync'
    case 'idle':
      return snapshot.lastSyncAt === null ? 'Not synced yet' : `Synced ${age(snapshot.lastSyncAt, now)}`
  }
}

/**
 * How long ago, in words. Relative rather than a clock time: "3 minutes ago"
 * answers "is my phone up to date?" without her having to know what time it
 * is now, and it carries no locale or timezone to get wrong. A clock that has
 * gone backwards (the device's time was corrected) reads as "just now" — a
 * negative age is never shown.
 */
function age(lastSyncAt: number, now: number): string {
  const elapsed = Math.max(0, now - lastSyncAt)
  if (elapsed < MINUTE) return 'just now'
  if (elapsed < HOUR) return plural(Math.floor(elapsed / MINUTE), 'minute')
  if (elapsed < DAY) return plural(Math.floor(elapsed / HOUR), 'hour')
  return plural(Math.floor(elapsed / DAY), 'day')
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'} ago`
}
