import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetFakeIdb } from './idb.test-support'

vi.mock('idb', async () => {
  const fake = await import('./idb.test-support')
  return { openDB: fake.openDB }
})

// Imported after the mock is registered, per Vitest's hoisting contract.
const idbModule = await import('idb')
const { openDatabase, DB_NAME, DECKS_STORE, SETTINGS_STORE, CLIPS_STORE } = await import('./database')

/**
 * Fixture: a v1 database, as it would sit on a real device today — no
 * `clips` store, real deck and settings data already written — opened
 * directly against the fake `idb` (bypassing `openDatabase`, which always
 * targets the app's current version) to simulate "existing data before this
 * change shipped". `openDatabase()` is then called the way the app really
 * calls it, exercising the v1 -> v2 upgrade path for the first time.
 */
async function seedV1Database(): Promise<void> {
  const v1db = await idbModule.openDB(DB_NAME, 1, {
    upgrade(db) {
      db.createObjectStore(DECKS_STORE, { keyPath: 'id' })
      db.createObjectStore(SETTINGS_STORE)
    },
  })
  await v1db.put(DECKS_STORE, {
    id: 'home',
    name: 'Home',
    phrases: [{ id: 'p1', french: 'Bonjour', english: 'Hello' }],
    createdAt: 1,
    updatedAt: 2,
  })
  await v1db.put(SETTINGS_STORE, 'sk-ant-abc123', 'anthropicApiKey')
}

describe('openDatabase v1 -> v2 migration', () => {
  beforeEach(() => {
    resetFakeIdb()
  })

  it('adds the clips store on top of a real v1 database, without touching existing decks or settings', async () => {
    await seedV1Database()

    const db = await openDatabase()

    expect(await db.get(DECKS_STORE, 'home')).toEqual({
      id: 'home',
      name: 'Home',
      phrases: [{ id: 'p1', french: 'Bonjour', english: 'Hello' }],
      createdAt: 1,
      updatedAt: 2,
    })
    expect(await db.get(SETTINGS_STORE, 'anthropicApiKey')).toBe('sk-ant-abc123')
    expect(db.objectStoreNames.contains(CLIPS_STORE)).toBe(true)
    expect(await db.getAll(CLIPS_STORE)).toEqual([])
  })

  it('lets clips be written and read once the migration has run', async () => {
    await seedV1Database()

    const db = await openDatabase()
    const clip = { hash: 'abc123', bytes: new ArrayBuffer(4), mime: 'audio/mpeg', durationMs: 1200, createdAt: 99 }
    await db.put(CLIPS_STORE, clip)

    expect(await db.get(CLIPS_STORE, 'abc123')).toEqual(clip)
  })

  it('creates a fresh database with all three stores when there is nothing to migrate from', async () => {
    const db = await openDatabase()

    expect(db.objectStoreNames.contains(DECKS_STORE)).toBe(true)
    expect(db.objectStoreNames.contains(SETTINGS_STORE)).toBe(true)
    expect(db.objectStoreNames.contains(CLIPS_STORE)).toBe(true)
  })
})
