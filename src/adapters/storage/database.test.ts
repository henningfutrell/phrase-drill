import { beforeEach, describe, expect, it } from 'vitest'
import { idbOperations, resetFakeIdb, terminateConnection } from './idb.test-support'

import * as idbModule from 'idb'
import {
  openDatabase,
  databaseTrouble,
  DB_NAME,
  DECKS_STORE,
  SETTINGS_STORE,
  CLIPS_STORE,
  CLIP_META_STORE,
  ERRORS_STORE,
  MIXES_STORE,
  TOMBSTONES_STORE,
} from './database'
import { CURRENT_SCHEMA_VERSION } from './migrations'

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
  // Real IndexedDB blocks an upgrade while an older connection is open, so
  // the fixture has to end the way a previous page load does: closed.
  v1db.close()
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
    v2db.close()
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
    v3db.close()
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

describe('openDatabase v5 -> v6 migration (T072: the upgrade may not load the clip cache)', () => {
  beforeEach(() => {
    resetFakeIdb()
  })

  /**
   * Fixture: a v5 database as it sits on her phone before this build — every
   * store except `clipMeta`, with real decks and a warm clip cache. The clip
   * cache is the whole point: it is modelled at ~890 MB at a full library
   * (docs/scale.md §1), and reading it whole inside a versionchange
   * transaction is an out-of-memory crash on the launch that upgrades — and
   * then again on every launch after it, because the upgrade retries. Her
   * library becomes permanently unreachable, not transiently broken.
   */
  async function seedV5Database(): Promise<void> {
    const v5db = await idbModule.openDB(DB_NAME, 5, {
      upgrade(db) {
        db.createObjectStore(DECKS_STORE, { keyPath: 'id' })
        db.createObjectStore(SETTINGS_STORE)
        db.createObjectStore(CLIPS_STORE, { keyPath: 'hash' })
        db.createObjectStore(ERRORS_STORE, { keyPath: 'id' })
        db.createObjectStore(MIXES_STORE, { keyPath: 'id' })
        db.createObjectStore(TOMBSTONES_STORE, { keyPath: 'id' })
      },
    })
    await v5db.put(DECKS_STORE, {
      id: 'home',
      name: 'Home',
      phrases: [{ id: 'p1', french: 'Bonjour', english: 'Hello' }],
      createdAt: 1,
      updatedAt: 2,
    })
    await v5db.put(MIXES_STORE, { id: 'm1', name: 'Mornings', deckIds: ['home'], createdAt: 3, updatedAt: 3 })
    await v5db.put(TOMBSTONES_STORE, { id: 'gone', kind: 'deck', deletedAt: 4 })
    await v5db.put(CLIPS_STORE, { hash: 'a', bytes: new ArrayBuffer(8), mime: 'audio/mpeg', durationMs: 1, createdAt: 10 })
    await v5db.put(CLIPS_STORE, { hash: 'b', bytes: new ArrayBuffer(4), mime: 'audio/mpeg', durationMs: 1, createdAt: 20 })
    v5db.close()
  }

  it('never reads the clip store while upgrading — not whole, and not clip by clip', async () => {
    await seedV5Database()
    idbOperations.length = 0

    await openDatabase()

    expect(idbOperations.filter((op) => op.store === CLIPS_STORE)).toEqual([])
  })

  it('adds the clipMeta store on top of a real v5 database, with every Deck, Mix, Tombstone and Clip intact', async () => {
    await seedV5Database()

    const db = await openDatabase()

    expect(db.objectStoreNames.contains(CLIP_META_STORE)).toBe(true)
    expect(await db.get(DECKS_STORE, 'home')).toEqual({
      id: 'home',
      name: 'Home',
      phrases: [{ id: 'p1', french: 'Bonjour', english: 'Hello' }],
      createdAt: 1,
      updatedAt: 2,
    })
    expect(await db.get(MIXES_STORE, 'm1')).toMatchObject({ name: 'Mornings' })
    expect(await db.get(TOMBSTONES_STORE, 'gone')).toEqual({ id: 'gone', kind: 'deck', deletedAt: 4 })
    expect((await db.getAll(CLIPS_STORE)).length).toBe(2)
  })
})

describe('openDatabase says so when the database cannot be opened (T072)', () => {
  beforeEach(() => {
    resetFakeIdb()
  })

  /**
   * The real condition, not a callback a double was asked to fire: another
   * connection — a second tab, a stale service-worker client — is holding the
   * previous version open, so IndexedDB refuses to start the upgrade and the
   * open request never settles. `openDatabase()`'s promise stays pending for
   * the whole of this test, which is precisely the failure being reported.
   */
  it('reports a blocked upgrade instead of waiting forever in silence', async () => {
    const holder = await idbModule.openDB(DB_NAME, CURRENT_SCHEMA_VERSION - 1, {
      upgrade(db) {
        db.createObjectStore(DECKS_STORE, { keyPath: 'id' })
      },
    })
    const seen: string[] = []
    const unsubscribe = databaseTrouble.subscribe((trouble) => seen.push(trouble))

    let settled = false
    void openDatabase().then(() => {
      settled = true
    })
    await waitFor(() => seen.length > 0)

    expect(seen).toEqual(['blocked'])
    expect(settled).toBe(false)
    unsubscribe()
    holder.close()
  })

  it('reports a connection the browser closed underneath it', async () => {
    const seen: string[] = []
    const unsubscribe = databaseTrouble.subscribe((trouble) => seen.push(trouble))

    const db = await openDatabase()
    terminateConnection(db)

    expect(seen).toEqual(['terminated'])
    unsubscribe()
  })

  it('stops reporting to a listener that unsubscribed', async () => {
    const seen: string[] = []
    const unsubscribe = databaseTrouble.subscribe((trouble) => seen.push(trouble))
    const db = await openDatabase()
    unsubscribe()

    terminateConnection(db)

    expect(seen).toEqual([])
  })
})

/** Let the real event loop turn until `condition` holds, or give up. */
async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !condition(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}
