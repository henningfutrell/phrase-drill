// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createLibraryStore } from './db.js'
import { fakeLibraryPool } from './pool.test-support.js'

/**
 * AUDIT T079 — FINDINGS 6 and 7. The real `createLibraryStore`, the repo's own
 * `fakeLibraryPool`, no HTTP.
 *
 * FINDING 6 — no concurrency control anywhere on the write path, so one of two
 * simultaneous pushes is dropped AND is not archived either.
 *
 *   server/app.js:359   const stored = await libraryStore.get(key)
 *   server/app.js:369   await libraryStore.put(key, JSON.stringify(parsed), Date.now())
 *   server/db.js:121      const previous = await get(key)
 *   server/db.js:135      await pool.query(`INSERT INTO libraries ... ON CONFLICT ... DO UPDATE ...
 *
 * Read and write are separate awaits at both levels. There is no transaction,
 * no `SELECT … FOR UPDATE`, and no compare-and-swap on `updated_at`. `db.js:99-101`
 * claims "there is no code path … that can replace the only off-device copy";
 * the claim is about crash-atomicity and does not survive interleaving.
 *
 * Both her phones sync on the same triggers — launch, reconnect, the phone
 * being locked — so simultaneous pushes are the ordinary case, not the exotic
 * one. Whichever push loses, its records are in neither `libraries` nor
 * `library_versions`. The loser's own device still holds them, so this is
 * repaired by that device's NEXT round-trip — and is permanent for anything
 * that device never gets to push again (it is lost, wiped, reinstalled, or
 * IndexedDB is evicted before it next syncs).
 *
 * FINDING 7 — the archive throttle can leave the only good copy in no place at
 * all.
 *
 *   server/db.js:124        if (archivedAt === null || now - archivedAt >= intervalMs) {
 *
 * The window is measured from the last ARCHIVE, and archives only happen on
 * puts. A real editing session pushes every two seconds (the sync debounce),
 * archives once at the start, and then archives nothing for an hour. A
 * destructive push inside that window replaces everything the session produced
 * with no history row behind it. `db.js:113-118` and `docs/server.md` state the
 * bound as "up to one hour of edits", so the trade is documented — but
 * `db.js:99-101`'s "there is no code path that can replace the only copy" is
 * not true inside the window, and that is the sentence a future change will be
 * read against.
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

describe('AUDIT T079 — the library row has no concurrency control', () => {
  it('FINDING 6: two simultaneous pushes drop one, and the dropped one is not archived', async () => {
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

    // DEMONSTRATION: one of the two phrases she typed is in neither the live
    // row nor the version history. The server never held it.
    expect(everywhere).toContain('la note')
    expect(everywhere).toContain('je cherche la gare')
  })

  it('FINDING 7: inside the throttle window a wipe replaces the only copy, with no history row', async () => {
    // One hour, as in production (LIBRARY_VERSION_SNAPSHOT_INTERVAL_MS).
    const store = await newStore({ snapshotIntervalMs: 3_600_000 })
    const hour = 3_600_000

    // A week ago, one push. Nothing archived yet — there was no previous row.
    await store.put('her', envelope([phrase('p0', 'week-old')]), 1, { now: 0 })

    // This morning's session: the sync debounce is two seconds, so a burst of
    // edits is a burst of pushes. The FIRST archives (an hour has passed);
    // every one after it is inside the window and archives nothing.
    for (let i = 1; i <= 30; i += 1) {
      await store.put('her', envelope([phrase(`p${i}`, `phrase ${i}`)]), i + 1, { now: hour * 24 * 7 + i * 2_000 })
    }

    // Anything that empties the row — the client bug the server refuses to
    // second-guess (app.js:364-368), a wipe, a bad restore pushed up.
    await store.put('her', envelope([]), 999, { now: hour * 24 * 7 + 61_000 })

    const row = (await store.get('her')).data
    const history = (await store.versions('her')).map((v) => v.data)
    const everywhere = [row, ...history].join('|')

    // DEMONSTRATION: this morning's phrases exist nowhere on the server. The
    // only archived version is from before the session started.
    expect(everywhere).toContain('phrase 30')
  })
})
