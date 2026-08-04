import { describe, expect, it } from 'vitest'
import { syncStatusText } from './sync-status-text'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const NOW = 1_000 * DAY

describe('syncStatusText — what the sync line says', () => {
  it('says a sync is running while it runs', () => {
    expect(syncStatusText({ state: 'syncing', lastSyncAt: NOW - MINUTE }, NOW)).toBe('Syncing…')
  })

  it('reports the time of the last successful sync when everything is up to date', () => {
    expect(syncStatusText({ state: 'idle', lastSyncAt: NOW - 5 * MINUTE }, NOW)).toBe('Synced 5 minutes ago')
  })

  it('says so plainly when nothing has ever synced, rather than implying one did', () => {
    expect(syncStatusText({ state: 'idle', lastSyncAt: null }, NOW)).toBe('Not synced yet')
  })

  it('never claims a sync happened while one is still waiting to go up', () => {
    const text = syncStatusText({ state: 'waiting', lastSyncAt: NOW - 2 * HOUR }, NOW)

    expect(text).toBe('Saved on this phone · will sync when back online · last synced 2 hours ago')
  })

  it('says the change is safe here even when there has never been a sync to fall back on', () => {
    expect(syncStatusText({ state: 'waiting', lastSyncAt: null }, NOW)).toBe(
      'Saved on this phone · will sync when back online · not synced yet',
    )
  })

  it('asks her to sign in again when the server stopped accepting this device', () => {
    expect(syncStatusText({ state: 'signed-out', lastSyncAt: NOW }, NOW)).toBe(
      'Saved on this phone · sign in again to sync',
    )
  })

  it('asks for an app update when this build is too old for the stored library', () => {
    expect(syncStatusText({ state: 'needs-update', lastSyncAt: NOW }, NOW)).toBe(
      'Saved on this phone · update the app to sync',
    )
  })
})

describe('syncStatusText — how a time is said', () => {
  it('calls the last minute "just now"', () => {
    expect(syncStatusText({ state: 'idle', lastSyncAt: NOW - 59_000 }, NOW)).toBe('Synced just now')
  })

  it('counts one minute in the singular', () => {
    expect(syncStatusText({ state: 'idle', lastSyncAt: NOW - MINUTE }, NOW)).toBe('Synced 1 minute ago')
  })

  it('counts minutes up to the hour', () => {
    expect(syncStatusText({ state: 'idle', lastSyncAt: NOW - 59 * MINUTE }, NOW)).toBe('Synced 59 minutes ago')
  })

  it('counts one hour in the singular', () => {
    expect(syncStatusText({ state: 'idle', lastSyncAt: NOW - HOUR }, NOW)).toBe('Synced 1 hour ago')
  })

  it('counts hours up to the day', () => {
    expect(syncStatusText({ state: 'idle', lastSyncAt: NOW - 23 * HOUR }, NOW)).toBe('Synced 23 hours ago')
  })

  it('counts one day in the singular', () => {
    expect(syncStatusText({ state: 'idle', lastSyncAt: NOW - DAY }, NOW)).toBe('Synced 1 day ago')
  })

  it('counts days beyond that', () => {
    expect(syncStatusText({ state: 'idle', lastSyncAt: NOW - 9 * DAY }, NOW)).toBe('Synced 9 days ago')
  })

  it('reads a clock that has gone backwards as "just now" rather than a negative age', () => {
    expect(syncStatusText({ state: 'idle', lastSyncAt: NOW + HOUR }, NOW)).toBe('Synced just now')
  })
})
