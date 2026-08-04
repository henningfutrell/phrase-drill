// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createLibraryStore, LIBRARY_VERSION_RECENT_COUNT, LIBRARY_VERSION_SNAPSHOT_INTERVAL_MS } from './db.js'
import { fakeLibraryPool } from './pool.test-support.js'

/**
 * T082, from the T079 audit's findings 4 and 6.
 *
 * FINDING 6 — there was no concurrency control anywhere on the write path, so
 * one of two simultaneous pushes was dropped AND archived nowhere.
 *
 *   server/app.js   const stored = await libraryStore.get(key)
 *   server/app.js   await libraryStore.put(key, ..., Date.now())
 *   server/db.js      const previous = await get(key)
 *   server/db.js      await pool.query(`INSERT INTO libraries ... ON CONFLICT ... DO UPDATE ...
 *
 * Read and write were separate autocommitted `pool.query` calls — no `BEGIN`,
 * no `COMMIT` and no `ROLLBACK` existed anywhere in `server/`. The claim at
 * `db.js` that "there is no code path … that can replace the only off-device
 * copy" was about crash-atomicity and did not survive interleaving.
 *
 * Both her phones sync on the same triggers — launch, reconnect, the phone
 * being locked — so simultaneous pushes are the ordinary case, not the exotic
 * one. Whichever push lost, its records were in neither `libraries` nor
 * `library_versions`. `put` now runs archive-and-overwrite inside one
 * transaction that takes `SELECT … FOR UPDATE` on the row first, so the second
 * push reads what the first wrote and archives it.
 *
 * FINDING 4 — the archive throttle could leave the only good copy in no place
 * at all.
 *
 *   server/db.js        if (archivedAt === null || now - archivedAt >= intervalMs) {
 *
 * The window was measured from the last ARCHIVE, and archives only happened on
 * puts. The client debounces at 2 s and pushes per edit, so an hour of ordinary
 * use is ~1,800 pushes and exactly ONE archive — of the oldest state in the
 * window. Everything she typed after that first push was unprotected for the
 * rest of the hour, and a destructive push inside it replaced the lot with no
 * history row behind it. Two 204s and no log line.
 *
 * T071's reasoning for the throttle is kept and is still right: a content-aware
 * trigger lets a bad push repeated archive its own shrunken states and prune
 * the good one out of the window. What changed is WHERE the throttle applies.
 * Every replaced version is now archived, and RETENTION does the thinning:
 * the newest `LIBRARY_VERSION_RECENT_COUNT` are kept whatever the push rate,
 * and everything older collapses to the OLDEST row per snapshot interval. A
 * flood therefore still cannot flush the aged history — the property T071
 * bought — and the version a wipe replaced is always still there.
 */

function envelope(decks) {
  return JSON.stringify({ format: 'phrase-drill-library', schemaVersion: 6, decks, mixes: [], tombstones: [] })
}

function phrase(id, french) {
  return { id: `d1`, name: 'Market', createdAt: 1, updatedAt: 2, phrases: [{ id, french, english: '' }] }
}

async function newStore(options) {
  const pool = fakeLibraryPool()
  const store = createLibraryStore(pool, options)
  await store.init()
  return store
}

async function newStoreWithPool(options) {
  const pool = fakeLibraryPool()
  const store = createLibraryStore(pool, options)
  await store.init()
  return { pool, store }
}

describe('the library row is written under a lock (T082, audit finding 6)', () => {
  it('FINDING 6: two simultaneous pushes both survive — the loser is archived, not dropped', async () => {
    const store = await newStore()
    await store.put('her', envelope([phrase('p0', 'bonjour')]), 1)

    // Both phones push at once. Each carries its own new phrase on top of the
    // copy it pulled. Node interleaves them at the awaits inside `put`.
    await Promise.all([
      store.put('her', envelope([phrase('pA', 'la note, s’il vous plaît')]), 2),
      store.put('her', envelope([phrase('pB', 'je cherche la gare')]), 3),
    ])

    const row = (await store.get('her')).data
    const history = (await store.versions('her')).map((v) => v.data)
    const everywhere = [row, ...history].join('|')

    // Neither phrase she typed may be in neither the live row nor the history.
    expect(everywhere).toContain('la note')
    expect(everywhere).toContain('je cherche la gare')
  })

  it('holds up under more than two writers at once', async () => {
    const store = await newStore()
    await store.put('her', envelope([phrase('p0', 'bonjour')]), 1)

    await Promise.all(Array.from({ length: 8 }, (_, i) => store.put('her', envelope([phrase(`p${i + 1}`, `phrase ${i + 1}`)]), i + 2)))

    const row = (await store.get('her')).data
    const everywhere = [row, ...(await store.versions('her')).map((v) => v.data)].join('|')
    for (let i = 1; i <= 8; i += 1) expect(everywhere).toContain(`phrase ${i}`)
  })

  it('wraps archive and overwrite in one transaction, taking the row lock before it reads', async () => {
    const { pool, store } = await newStoreWithPool()
    await store.put('her', envelope([phrase('p0', 'bonjour')]), 1)
    pool.queries.length = 0
    await store.put('her', envelope([phrase('p1', 'un')]), 2)

    const text = pool.queries.map((q) => q.text)
    const begin = text.findIndex((t) => /^\s*BEGIN/i.test(t))
    const select = text.findIndex((t) => /FOR UPDATE/i.test(t))
    const archive = text.findIndex((t) => t.includes('INSERT INTO library_versions'))
    const overwrite = text.findIndex((t) => t.includes('INSERT INTO libraries'))
    const commit = text.findIndex((t) => /^\s*COMMIT/i.test(t))

    expect(begin).toBe(0)
    expect(begin).toBeLessThan(select)
    expect(select).toBeLessThan(archive)
    expect(archive).toBeLessThan(overwrite)
    expect(overwrite).toBeLessThan(commit)
  })

  it('rolls back and releases the connection when the overwrite fails, rather than leaving the transaction open', async () => {
    const { pool, store } = await newStoreWithPool()
    await store.put('her', envelope([phrase('p0', 'bonjour')]), 1)

    pool.failNext(/INSERT INTO libraries/)
    await expect(store.put('her', envelope([phrase('p1', 'un')]), 2)).rejects.toThrow()

    expect(pool.queries.some((q) => /^\s*ROLLBACK/i.test(q.text))).toBe(true)
    expect(pool.leased).toBe(0)

    // The store still works afterwards — a failed put is not a poisoned pool.
    await store.put('her', envelope([phrase('p2', 'deux')]), 3)
    expect((await store.get('her')).data).toContain('deux')
  })

  it('releases the connection on the happy path too', async () => {
    const { pool, store } = await newStoreWithPool()
    await store.put('her', envelope([phrase('p0', 'bonjour')]), 1)
    await store.put('her', envelope([phrase('p1', 'un')]), 2)

    expect(pool.leased).toBe(0)
  })
})

describe('every replaced version is archived; retention does the thinning (T082, audit finding 4)', () => {
  const hour = LIBRARY_VERSION_SNAPSHOT_INTERVAL_MS

  it('FINDING 4: a wipe inside the throttle window cannot take the session’s work with it', async () => {
    const store = await newStore({ snapshotIntervalMs: hour })

    // A week ago, one push. Nothing archived yet — there was no previous row.
    await store.put('her', envelope([phrase('p0', 'week-old')]), 1, { now: 0 })

    // This morning's session: the sync debounce is two seconds, so a burst of
    // edits is a burst of pushes, all inside one snapshot interval.
    for (let i = 1; i <= 30; i += 1) {
      await store.put('her', envelope([phrase(`p${i}`, `phrase ${i}`)]), i + 1, { now: hour * 24 * 7 + i * 2_000 })
    }

    // Anything that empties the row — the client bug the server refuses to
    // second-guess, a wipe, a bad restore pushed up.
    await store.put('her', envelope([]), 999, { now: hour * 24 * 7 + 61_000 })

    const row = (await store.get('her')).data
    const history = (await store.versions('her')).map((v) => v.data)
    const everywhere = [row, ...history].join('|')

    // The last state before the wipe is recoverable.
    expect(everywhere).toContain('phrase 30')
  })

  it('keeps the newest LIBRARY_VERSION_RECENT_COUNT replaced versions whatever the push rate', async () => {
    const store = await newStore({ snapshotIntervalMs: hour })
    await store.put('her', envelope([phrase('p0', 'start')]), 0, { now: 0 })
    for (let i = 1; i <= 200; i += 1) {
      await store.put('her', envelope([phrase(`p${i}`, `phrase ${i}`)]), i, { now: i * 2_000 })
    }

    const history = (await store.versions('her')).map((v) => v.data)
    for (let i = 200 - LIBRARY_VERSION_RECENT_COUNT; i < 200; i += 1) {
      expect(history.join('|')).toContain(`phrase ${i}`)
    }
  })

  it('a flood still cannot flush the aged history — an hour of pushes collapses to its oldest state', async () => {
    // T071's property, restated where it now lives. 1,800 pushes is one hour
    // of ordinary editing at the client's 2 s debounce.
    const store = await newStore({ snapshotIntervalMs: hour })
    await store.put('her', envelope([phrase('p0', 'the good copy')]), 0, { now: 0 })
    for (let i = 1; i <= 1_800; i += 1) {
      await store.put('her', envelope([phrase(`p${i}`, `phrase ${i}`)]), i, { now: i * 2_000 })
    }
    // An hour later, one more push, so the flood is fully aged.
    await store.put('her', envelope([phrase('last', 'later')]), 9_999, { now: hour * 3 })

    const history = (await store.versions('her')).map((v) => v.data)

    // The state before the flood started is still there.
    expect(history.join('|')).toContain('the good copy')
    // And the flood did not consume the retention window.
    expect(history.length).toBeLessThan(LIBRARY_VERSION_RECENT_COUNT + 10)
  })

  it('archives nothing when the pushed bytes are identical to what is stored', async () => {
    const store = await newStore({ snapshotIntervalMs: hour })
    await store.put('her', envelope([phrase('p1', 'un')]), 1, { now: 0 })
    await store.put('her', envelope([phrase('p1', 'un')]), 2, { now: 5_000 })

    expect(await store.versions('her')).toEqual([])
  })
})
