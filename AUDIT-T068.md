# AUDIT-T068 — how this app can lose her phrases

Read-only adversarial audit of every write, read, merge, migration, eviction and
delete path. Findings ranked by expected harm. **CONFIRMED** = traced in code and,
where marked, demonstrated by a failing audit test. **SUSPECTED** = mechanism is in
the code, trigger probability not proven here.

Audit artifacts (throwaway, **not** production tests — delete or convert deliberately):

- `src/domain/AUDIT-T068.audit.test.ts` — 4 failing cases against `mergeLibraries`
- `src/adapters/sync/AUDIT-T068.audit.test.ts` — 4 failing cases against the sync engine and the restore parser

Run: `npx vitest run src/domain/AUDIT-T068.audit.test.ts src/adapters/sync/AUDIT-T068.audit.test.ts`
All 8 assertions fail. Each failure is a loss.

---

## 1. CONFIRMED — a server rollback makes the merge delete her phrases from the phone

`src/domain/library-merge.ts:238-239`, reached from `:168` `mergePhrases`.

```ts
const kept = mine ?? theirs
if (kept && !samePhrase(before, kept)) merged.push(kept)
```

"Present on one side only, and unchanged from the baseline" is read as **the other
side deleted it**. That is only true if the other side is a *descendant* of the
baseline. The server is not guaranteed to be.

Sequence:

1. She adds phrase `p2` on the phone. It syncs. `baseline` (settings key
   `syncBaseline`, `sync-baseline-store.ts:29`) now contains `p2`.
2. The server row goes backwards: a `scripts/restore-drill.mjs` / `backup.mjs`
   `pg_dump` restore (T054/T065), an older device's push winning a concurrent
   write at `server/app.js:316`, or any manual repair of `libraries.data`.
3. The remote deck is also edited (any device), so `localChanged && remoteChanged`
   and `reconcileDeck` (`:165`) enters the three-way path.
4. `before` has `p2`, `mine` has `p2` unchanged, `theirs` does not. `samePhrase(before, mine)`
   is true → `p2` is dropped from the merge, written to IndexedDB by `writeLocal`
   (`sync-engine.ts:183`) and pushed to the server.

**Lost:** every phrase added since the server's rollback point that had already been
pushed. No tombstone. Silent. Both copies destroyed in the same round-trip.

Whole *decks* survive this (`mergeDecks:147` keeps an id only one side has), which
makes it worse — the deck is still there, just short some phrases, so nothing looks
wrong.

**The recovery procedure is the attack.** Using the pg_dump restore drill on the real
database is exactly step 2. Demonstrated: `AUDIT F-01`.

---

## 2. CONFIRMED — one exception anywhere in the round-trip kills sync for the whole session, silently

`src/adapters/sync/sync-engine.ts:224-241`.

```ts
try {
  const result = await roundTrip()
  ...
} finally {
  running = false
}
```

There is no `catch`. `roundTrip` awaits four things that can *throw* rather than
return a result:

| Line | Call | Throws when |
|---|---|---|
| `:165` | `deps.client.pull()` | `library-sync-client.ts:73` calls `response.json()` **outside** its try. A corrupt `libraries.data` row — served raw by `server/app.js:263` `res.end(row.data)` with no validation — throws `SyntaxError`. So does a truncated response. |
| `:183` | `deps.writeLocal(...)` | `QuotaExceededError` on iOS when the origin is full (very reachable — the clip cache alone is allowed 200 MB, plus a second whole copy of the library in `syncBaseline`). Also any IDB abort. |
| `:190` | `deps.baseline.write(...)` | same |
| `:192` | `deps.recordSync(...)` | same |

`run()` rejects. `void run()` (`:268`, `:207`, `:213`) discards it. `state` stays
`'syncing'` forever, `running` is reset by `finally` but nothing ever calls `run()`
again — `scheduleRetry` is never reached, `onOnline` only fires when
`state !== 'idle'`… and `'syncing'` passes that test, so a reconnect *can* restart
it, but nothing else will.

**Lost:** everything she writes for the rest of that session, and every session after
it that hits the same condition, never reaches the server. The sync line shows
"syncing", which reads as working. She only finds out when the phone is wiped or
replaced. Demonstrated: `AUDIT F-05` (both variants).

---

## 3. CONFIRMED — every local write in the UI is fire-and-forget with no error handler

`src/App.tsx`:

```
287:  void deckStore.save(deck).then(() => syncToServer())
315:  void mixStore.save(mix).then(() => syncToServer())
341:  void mixStore.remove(id).then(() => syncToServer())
346:  void deckStore.remove(id).then(() => syncToServer())
403:  void deckStore.importAll(library).then(...)
```

Not one `.catch`. `persist()` (`:284-288`) calls `setDecks(...)` **first**, so the
phrase renders immediately; if `deckStore.save` then rejects — `QuotaExceededError`,
a `versionchange` abort, an IDB connection killed by iOS under memory pressure — the
UI shows the phrase, disk does not have it, and she is told nothing. The rejection
lands in `installErrorCapture` → the `errors` ring buffer → a Diagnostics screen a
non-technical user will never open.

**Lost:** an entire scanning session's phrases. She scans a page, sees ten phrases
appear, closes the app, and they are gone. This is the most likely single-event loss
in ordinary use.

Same shape at `:346` for `remove` — a delete that appears to work but leaves the deck
on disk, which the next sync resurrects.

---

## 4. CONFIRMED — restore-from-file cannot recover a deleted deck

`src/App.tsx:397-408` → `indexed-db-deck-store.ts:90` `importAll` → `syncToServer()`.

`importAll` clears the `tombstones` store and writes the backup file's tombstones
(none, for a backup taken before the delete). The **server** still holds the
tombstone. On the sync seconds later, `mergeTombstones` keeps it and
`isDeleted(deck, tombstone)` (`library-merge.ts:267`) is true because
`deletedAt >= updatedAt` — the restored deck's `updatedAt` is old by construction.

**Lost:** the deck is deleted again, immediately, and the restore is undone before she
can look at it. The one deletion case a backup exists for is the one case restore
cannot fix. Demonstrated: `AUDIT F-02`.

The same logic means restoring *any* old backup is silently a no-op for everything
the server has newer — restore is "merge into the server's view", not "replace",
despite `library.ts:19` documenting it as "warns, then replaces".

---

## 5. SUSPECTED (high) — the v5→v6 upgrade can make the database permanently unopenable

`src/adapters/storage/database.ts:121-129`.

```ts
const clips = (await transaction.objectStore(CLIPS_STORE).getAll()) as {...}[]
```

`getAll()` on `clips` materializes **every cached audio `ArrayBuffer`** — the whole
cache — into the JS heap at once, inside the `versionchange` transaction. Before
T036 the cache was unbounded; `docs/scale.md` models ~890 MB at a full library.

Answering the specific questions asked:

- **Killed mid-upgrade / transaction aborts:** IndexedDB rolls the versionchange
  transaction back atomically. Decks are *not* damaged, and `clipMeta` is not created.
  **But the version does not advance**, so the next launch runs the identical
  `getAll` and fails the identical way. That is a crashloop, not a one-off. The app
  never opens. Her data is intact on disk and unreachable, which for a non-technical
  user is indistinguishable from lost — and the fix she knows is "delete the app /
  clear website data", which *is* loss.
- **`clips` is huge:** on iOS Safari a several-hundred-MB structured-clone
  deserialization is a plausible jetsam kill. There is no chunking, no cursor, no
  size check, and no fallback that creates `clipMeta` empty and backfills lazily.
- **Two tabs at once:** `openDB` is called with **no `blocked` and no `terminated`
  callback** (`database.ts:69`). Five separate connections are opened
  (`deckStore`, `mixStore`, `settingsStore`, `clipCache`, `syncBaselineStore` — each
  calls `openDatabase()` independently). An old-build tab or the installed PWA
  holding a v5 connection blocks the v6 upgrade indefinitely; `openDB` never
  resolves, no error is raised, and the app hangs with no message. Note `vite.config.ts`
  uses `registerType: 'autoUpdate'` + `skipWaiting`, which makes "one surface on the
  new build, one on the old" more likely, not less.
- **Existing tests cannot catch any of this.** `idb.test-support.ts:108-110` sets
  `db.version = version` *before* invoking the upgrade callback, so the fake cannot
  model an aborted versionchange.

Recommended shape: create `clipMeta` empty, backfill outside the upgrade with a
cursor, and treat a missing meta row as a cache miss.

---

## 6. CONFIRMED — clock skew between her two devices silently deletes and silently discards edits

`library-merge.ts:267` (`deletedAt >= updatedAt`) and `:123` / `:157` (`updatedAt`
comparisons) trust two unsynchronized wall clocks. `indexed-db-deck-store.ts:57,78`
stamp `Date.now()` on the writing device.

- A deck written on the device with the *slower* clock always loses whole-record
  last-write-wins against an older edit on the faster one. Her phone edits vanish
  and the web copy comes back. No tombstone, no signal.
- A tombstone from the fast device outranks a genuinely newer record from the slow
  one, deleting it. Demonstrated: `AUDIT F-03`.
- Tombstones are never garbage-collected (`database.ts:50`, deliberate), so a
  skewed tombstone is permanent.

iOS clocks are NTP-synced so ordinary skew is small; a phone that has been off,
in airplane mode, or had its date set manually is the trigger.

---

## 7. CONFIRMED — the version guard is bypassed by an empty `decks` array, and a valid-shaped empty file is a total wipe

`library.ts:137` `library.decks.map(...)` is the **only** place `schemaVersion` is
checked (via `applyMigrations:57`). An empty array runs zero migrations, so:

- `normalizeLibrary({schemaVersion: 99, decks: []})` returns `schemaVersion: 6` with
  no error (demonstrated: `AUDIT F-06`). A future-build envelope is silently
  downgraded instead of producing `needs-update`.
- `parseLibraryFile` accepts `{format, schemaVersion, decks: []}` (demonstrated).
  `handleConfirmRestore` then calls `importAll`, whose first three statements are
  `deckStore.clear()`, `mixStore.clear()`, `tombstoneStore.clear()`
  (`indexed-db-deck-store.ts:99-101`), unconditionally.

**Lost:** the whole local library, committed, from a file that was truncated at the
wrong place, hand-edited, or was a backup taken before she had any decks. There is no
"this will replace N decks with 0" confirmation derived from the file's contents.

`mixes` and `tombstones` are never validated element-wise on either the restore path
or the server (`app.js:284-294`) — only "is an array".

**What does hold:** `importAll` genuinely is one transaction over all three stores
(`:95`), so a mid-import failure aborts and rolls back. No partial restore is
possible. That claim in the doc comment is true.

---

## 8. CONFIRMED — eviction can only touch clip stores (the claim holds), but it is not atomic

Proven by exhaustive grep of every delete/clear in `src/`:

```
clip-cache.ts:219   db.delete(CLIPS_STORE, hash)
clip-cache.ts:220   db.delete(CLIP_META_STORE, hash)
```

Both store names are module constants. Nothing in `clip-cache.ts` enumerates
`objectStoreNames`, uses `IDBKeyRange`, or calls `clear()`. The only other deletes
are `error-log.ts:75` (`errors`), `settings-store.ts:86` (`settings`, by explicit
key), `indexed-db-deck-store.ts:75`/`indexed-db-mix-store.ts:47` (explicit id), and
`importAll`'s three clears. **Eviction cannot reach a Deck, Mix or Tombstone.
Disproven as a direct threat.**

Two second-order defects remain:

- The two deletes at `:219-220` are **separate transactions**. A crash between them
  leaves either an orphan clip with no meta row — invisible to `totalBytes` forever,
  so the 200 MB ceiling silently stops binding and the origin grows without limit —
  or a meta row with no clip, so `has()` says ready and `get()` returns `undefined`.
  The unbounded-origin case is the exact condition the ceiling exists to prevent, and
  the consequence is Safari discarding the **whole origin**, phrases included.
- `totalBytes` and the index are per-`ClipCache`-instance in-memory state
  (`:161-164`). Nothing rereads them. A clip written by another connection or by the
  v6 backfill after `getIndex()` resolved is uncounted.

---

## 9. CONFIRMED — the round-trip is a read-modify-write race against her typing

`sync-engine.ts:171` `readLocal()` → `:172` `baseline.read()` (reads a whole second
copy of the library off disk) → `:183` `writeLocal(outgoing)` → `importAll` →
`clear()` + rewrite.

Any `deckStore.save` / `mixStore.save` that commits inside that window is erased by
the `clear()`. The window is IndexedDB reads, not a network call (the pull is before
`readLocal`), so it is short — tens of milliseconds — but it is entered on **every**
sync, including the debounced one fired 2 s after she starts typing.

Demonstrated: `AUDIT F-08`. Real, low probability per occurrence, unbounded over
months.

---

## 10. CONFIRMED — the server accepts a PUT that shrinks the library, with no tombstone

`server/app.js:266-319`. Validation is shape only: `format`, `schemaVersion` numeric,
`decks`/`mixes`/`tombstones` are arrays. The only refusal is the 409 for
`schemaVersion < storedSchemaVersion`. Then `libraryStore.put` (`db.js:42`) is an
unconditional `INSERT … ON CONFLICT DO UPDATE SET data = excluded.data`.

So `PUT {format, schemaVersion: 6, decks: []}` replaces her entire server-side
library with nothing, 204, no audit trail, no previous version retained. Nothing in
`libraries` keeps history — one row, overwritten in place. The only copy of the
previous state is Render's managed Postgres backup.

`get`/`put` are also not in one transaction (`app.js:311` then `:316`), so two
devices pushing concurrently is last-writer-wins at the row level. Self-healing *if*
the loser syncs again; permanent if it does not.

`storedSchemaVersion` (`app.js:41-48`) returns `0` for a row that is not JSON, so a
corrupt row is deliberately overwritable. That is the right call — but the matching
read path (`handleLibraryGet:263`) streams the corrupt bytes straight back to the
device, where they crash `pull()` (see finding 2).

Answering "partial write": `data` is a single TEXT column written by one statement,
so Postgres gives atomicity here. A partial write is not reachable through this code.
A row predating a schema change is handled by `normalizeLibrary` on the device.

---

## 11. CONFIRMED — duplicate phrase ids collapse silently in a three-way merge

`library-merge.ts:213-216` builds `Map`s by id and a de-duplicated id list. Two
phrases sharing an id — a hand-edited restore file, an import bug, a future
copy-deck feature — become one, keeping only the last. Demonstrated: `AUDIT F-04`.
Low likelihood today; there is no uniqueness check anywhere on the write path.

---

## 12. SUSPECTED — the server-side clip store grows without bound on a 1 GB database plan

`server/db.js:78-124` (T063). `clips.bytes` is `BYTEA`, in the **same** Postgres as
`libraries`. There is no eviction, no TTL, no size cap, and no `DELETE FROM clips`
anywhere in `server/` or `scripts/`. Every re-pinned voice, every corrected phrase,
every model change orphans the old rows permanently — the content address changes,
the old row stays.

`render.yaml:22` pins `plan: basic-256mb`, the smallest paid tier. When that disk
fills, `libraryStore.put` starts failing → 500 → `push` returns `network` → the
engine retries forever and the sync line says "waiting". Her library stops reaching
the server while the app looks healthy, and the pg_dump backup gets larger and slower
until it too fails.

Worth measuring the current `pg_total_relation_size('clips')` before deciding urgency.

---

## 13. Also noted

- **`requestPersistence` is only called from `deckStore.save`**
  (`indexed-db-deck-store.ts:34-38, 54`). A device that only reads never asks for
  durable storage, and if `persist()` returns false the result is logged to
  `console.warn` and nowhere else (`persistence.ts:18-20`). iOS ITP's 7-day eviction
  of non-persisted storage is a whole-library deletion that nothing surfaces. Sync
  usually recovers it — unless the device is offline at the wrong moment, or the
  round-trip died per finding 2.
- **The baseline is a full second copy of the library** stored in the `settings`
  store (`sync-baseline-store.ts:47`), doubling the library's IndexedDB footprint and
  the exposure to quota failures in finding 2/3.
- **`mergeLibraries`'s schema-version guards (`:70`, `:75`) are dead code** on the
  sync path — both inputs and the baseline have already been stamped to
  `CURRENT_SCHEMA_VERSION` by `normalizeLibrary`.
- **`readLastSyncAt().then(...)` at `sync-engine.ts:264` has no `.catch`** — another
  unhandled rejection source.

---

## Ranked answer to "what is most likely to lose phrases next month"

1. A save that fails silently (finding 3) — most likely per-event, and it happens
   during the one activity that matters, scanning in handwritten phrases.
2. A sync engine that died on an exception hours ago and still says "syncing"
   (finding 2), so nothing since has left the phone.
3. Using the pg_dump restore to fix something (finding 1), which then deletes newer
   phrases off the phone.
4. The v6 upgrade bricking the database on her actual clip cache (finding 5).
