import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetFakeIdb } from './idb.test-support'

vi.mock('idb', async () => {
  const fake = await import('./idb.test-support')
  return { openDB: fake.openDB }
})

// Imported after the mock is registered, per Vitest's hoisting contract.
const idbModule = await import('idb')
const { openDatabase, DB_NAME, DECKS_STORE, SETTINGS_STORE, CLIPS_STORE, ERRORS_STORE, MIXES_STORE } = await import('./database')

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

  it('creates a fresh database with every store when there is nothing to migrate from', async () => {
    const db = await openDatabase()

    expect(db.objectStoreNames.contains(DECKS_STORE)).toBe(true)
    expect(db.objectStoreNames.contains(SETTINGS_STORE)).toBe(true)
    expect(db.objectStoreNames.contains(CLIPS_STORE)).toBe(true)
    expect(db.objectStoreNames.contains(ERRORS_STORE)).toBe(true)
    expect(db.objectStoreNames.contains(MIXES_STORE)).toBe(true)
  })
})

describe('openDatabase v2 -> v3 migration', () => {
  beforeEach(() => {
    resetFakeIdb()
  })

  /** Fixture: a v2 database (clips store present, errors store not yet) —
   * "existing data before T039 shipped". */
  async function seedV2Database(): Promise<void> {
    const v2db = await idbModule.openDB(DB_NAME, 2, {
      upgrade(db) {
        db.createObjectStore(DECKS_STORE, { keyPath: 'id' })
        db.createObjectStore(SETTINGS_STORE)
        db.createObjectStore(CLIPS_STORE, { keyPath: 'hash' })
      },
    })
    await v2db.put(DECKS_STORE, {
      id: 'home',
      name: 'Home',
      phrases: [{ id: 'p1', french: 'Bonjour', english: 'Hello' }],
      createdAt: 1,
      updatedAt: 2,
    })
  }

  it('adds the errors store on top of a real v2 database, without touching existing decks', async () => {
    await seedV2Database()

    const db = await openDatabase()

    expect(await db.get(DECKS_STORE, 'home')).toMatchObject({ id: 'home', name: 'Home' })
    expect(db.objectStoreNames.contains(ERRORS_STORE)).toBe(true)
    expect(await db.getAll(ERRORS_STORE)).toEqual([])
  })

  it('lets error log entries be written and read once the migration has run', async () => {
    await seedV2Database()

    const db = await openDatabase()
    const entry = { id: 1, timestamp: 1, source: 'window.onerror', message: 'boom' }
    await db.put(ERRORS_STORE, entry)

    expect(await db.get(ERRORS_STORE, 1)).toEqual(entry)
  })
})

describe('openDatabase v3 -> v4 migration (T059: saved Mixes)', () => {
  beforeEach(() => {
    resetFakeIdb()
  })

  /**
   * Fixture: a v3 database as it sits on her phone today — decks, settings,
   * clips and errors already written, no `mixes` store. This is the exact
   * state the upgrade has to survive without losing a single Phrase.
   */
  async function seedV3Database(): Promise<void> {
    const v3db = await idbModule.openDB(DB_NAME, 3, {
      upgrade(db) {
        db.createObjectStore(DECKS_STORE, { keyPath: 'id' })
        db.createObjectStore(SETTINGS_STORE)
        db.createObjectStore(CLIPS_STORE, { keyPath: 'hash' })
        db.createObjectStore(ERRORS_STORE, { keyPath: 'id' })
      },
    })
    await v3db.put(DECKS_STORE, {
      id: 'home',
      name: 'Home',
      phrases: [
        { id: 'p1', french: 'Bonjour', english: 'Hello' },
        { id: 'p2', french: 'Merci', english: 'Thank you' },
      ],
      createdAt: 1,
      updatedAt: 2,
    })
    await v3db.put(DECKS_STORE, {
      id: 'work',
      name: 'Work',
      phrases: [{ id: 'p3', french: 'Réunion', english: 'Meeting' }],
      createdAt: 3,
      updatedAt: 4,
    })
    await v3db.put(SETTINGS_STORE, { provider: 'elevenlabs', modelId: 'm1', voiceId: 'v1' }, 'voice')
    await v3db.put(CLIPS_STORE, { hash: 'abc', bytes: new ArrayBuffer(2), mime: 'audio/mpeg', durationMs: 1, createdAt: 1 })
  }

  it('adds the mixes store on top of a real v3 database, with every Deck and Phrase intact', async () => {
    await seedV3Database()

    const db = await openDatabase()

    expect(db.objectStoreNames.contains(MIXES_STORE)).toBe(true)
    expect(await db.getAll(MIXES_STORE)).toEqual([])
    expect(await db.get(DECKS_STORE, 'home')).toEqual({
      id: 'home',
      name: 'Home',
      phrases: [
        { id: 'p1', french: 'Bonjour', english: 'Hello' },
        { id: 'p2', french: 'Merci', english: 'Thank you' },
      ],
      createdAt: 1,
      updatedAt: 2,
    })
    expect(await db.get(DECKS_STORE, 'work')).toMatchObject({ name: 'Work' })
    expect((await db.getAll(DECKS_STORE)).length).toBe(2)
  })

  it('leaves settings and the clip cache untouched across the upgrade', async () => {
    await seedV3Database()

    const db = await openDatabase()

    expect(await db.get(SETTINGS_STORE, 'voice')).toEqual({ provider: 'elevenlabs', modelId: 'm1', voiceId: 'v1' })
    expect(await db.get(CLIPS_STORE, 'abc')).toMatchObject({ hash: 'abc', mime: 'audio/mpeg' })
  })

  it('lets a Mix be written and read once the migration has run', async () => {
    await seedV3Database()

    const db = await openDatabase()
    const mix = { id: 'm1', name: 'Mornings', deckIds: ['home', 'work'], createdAt: 5, updatedAt: 5 }
    await db.put(MIXES_STORE, mix)

    expect(await db.get(MIXES_STORE, 'm1')).toEqual(mix)
  })

  it('carries a v1 database all the way to v4 in one open, decks intact', async () => {
    await seedV1Database()

    const db = await openDatabase()

    expect(await db.get(DECKS_STORE, 'home')).toEqual({
      id: 'home',
      name: 'Home',
      phrases: [{ id: 'p1', french: 'Bonjour', english: 'Hello' }],
      createdAt: 1,
      updatedAt: 2,
    })
    expect(db.objectStoreNames.contains(MIXES_STORE)).toBe(true)
  })
})
