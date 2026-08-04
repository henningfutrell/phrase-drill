# AUDIT-T079 — how phrase-drill can still lose rene's phrases

Second audit. Seven demonstrated data-loss or data-safety defects, each with a
failing test committed beside it. Six suspicions, labelled as such. A list of
what was checked and found clean at the bottom.

**`npm test` fails with these tests present. That is the deliverable.** Nothing
was fixed — a fix would hide the evidence.

```
Test Files  5 failed | 87 passed | 2 skipped (94)
Tests       9 failed | 1119 passed | 8 skipped (1136)
```

The 5 failing files and all 9 failing tests are this audit's. Every pre-existing
test passes.

| # | Finding | Test |
|---|---------|------|
| 1 | A restore confirmed while a round-trip is pushing is silently undone | `src/adapters/sync/restore-during-round-trip.audit.test.ts` |
| 2 | The server stores an envelope it will then permanently refuse to serve | `server/library-envelope.audit.test.js` |
| 3 | A Sync Baseline written by the previous build kills sync for good | `src/adapters/sync/sync-baseline-upgrade.audit.test.ts` |
| 4 | Inside the archive throttle a wipe replaces the only server copy | `server/library-store-concurrency.audit.test.js` |
| 5 | One unbounded `schemaVersion` locks every device out of sync | `server/library-envelope.audit.test.js` |
| 6 | Two simultaneous pushes drop one, and do not archive it | `server/library-store-concurrency.audit.test.js` |
| 7 | A database that cannot be read at launch says nothing at all | `src/App.launch-read.audit.test.tsx` |

---

## 1. A restore confirmed while a round-trip is pushing is silently undone

**What is lost:** every Deck and Phrase the backup file restored, on the phone
and on the server, seconds after she watches the restore work. This is the T072
defect verbatim, resurrected by a race that T072 did not close.

**Where:**

- `src/adapters/sync/sync-engine.ts:269` — `await deps.baseline.write(outgoing)`
- `src/adapters/sync/sync-engine.ts:235` — `outgoing` is computed here, before the restore
- `src/adapters/sync/sync-engine.ts:256` — `pushed = await deps.client.push(outgoing)` — the window
- `src/adapters/sync/sync-engine.ts:424-426` — `libraryRestored()`, which writes the empty baseline
- `src/App.tsx:550-560` — the restore awaits `libraryRestored()` and never stops the engine

**Sequence:**

1. A round-trip is running. It has already computed `outgoing` — the pre-restore
   merge — and is awaiting `client.push(outgoing)`. On her phone that is a
   network call: seconds, longer on a bad signal.
2. She confirms a restore. `App.tsx:559` awaits `syncEngine.libraryRestored()`,
   which sets the Sync Baseline to an empty library. That is the whole of T072's
   mechanism: an empty baseline makes every restored record read as *written
   since the last agreement*, so it outranks a Tombstone the server still holds.
3. `App.tsx:560` writes the restored library. So far, correct.
4. The push lands. `sync-engine.ts:269` runs and writes `outgoing` over the
   baseline. **The empty baseline is gone.** The baseline now holds exactly the
   records the restore was supposed to have disowned.
5. The restore's own sync (`App.tsx:573`) pulls the server copy, which carries
   the other device's Tombstone. `library-merge.ts:407-415` (`rewritten`) finds
   the restored Deck identical to what the baseline holds → not rewritten;
   `library-merge.ts:437-445` (`isDeleted`) then lets the Tombstone through.
   The Deck is deleted locally and stays deleted on the server.

Nothing is said. `libraryRevision` bumps, the screens re-read, and the Deck is
simply not there.

**How it was demonstrated:** `restore-during-round-trip.audit.test.ts` runs the
real `createSyncEngine` and the real `mergeLibraries` against a fake server whose
`push` can be held open. Test 1 pins the baseline being overwritten; test 2 pins
the loss — `h.local.decks` is `[]` where she restored `d1`, and the server's
Tombstone survives.

Every existing test for T072 (`sync-engine.test.ts:786`, `:806`, `:827`) calls
`libraryRestored()` with the engine idle. The race was never exercised.

---

## 2. The server stores an envelope it will then permanently refuse to serve

**What is lost:** her whole server-side copy becomes unservable, permanently,
and the device is structurally unable to push its good copy back over it. Only
`psql` can repair it. If the phone is then lost or wiped, everything is gone.

**Where:**

- `server/app.js:45` — `typeof value.schemaVersion === 'number' &&`
- `server/app.js:342` — `if (!isLibraryEnvelope(parsed)) return sendJson(res, 400, { error: 'invalid-request' })`
- `server/app.js:369` — `await libraryStore.put(key, JSON.stringify(parsed), Date.now())`
- `server/app.js:313-315` — the same shape test on the read path, returning 500 `library-unreadable`
- `src/adapters/sync/sync-engine.ts:198` — a failed pull skips the push

**Sequence:**

1. A PUT body of `{"format":"phrase-drill-library","schemaVersion":1e999,"decks":[]}`.
   Legal JSON. `JSON.parse` yields `Infinity`, and `typeof Infinity === 'number'`,
   so `isLibraryEnvelope` (app.js:45) passes it.
2. The stale-client gate at app.js:360 compares `Infinity < 6` → false → accepted.
3. app.js:369 stores `JSON.stringify(parsed)`, which emits `"schemaVersion":null`.
   **Her library row has already been overwritten by then.** 204.
4. Every later GET parses that row, runs the *same* test at app.js:313, now fails
   it, and returns 500 (app.js:315).
5. The device can never repair it. `library-sync-client.ts:85` maps a 500 to
   `network`; `sync-engine.ts:198` then returns before the push, so the intact
   library on her phone can never go back up. The sync line reads *"Saved on this
   phone · will sync when back online"* for the rest of time.

The defect is that validation is applied to the parsed value and storage is
applied to a re-serialization of it. They are not the same value and nothing
checks the second.

`docs/sync.md` names a permanently corrupt row as a residual gap arising from
hand repair or a truncated upstream write. It does not name a request this
server validated and answered 204 to.

**How it was demonstrated:** `server/library-envelope.audit.test.js`, first test
— the real `createApp`, the real `createLibraryStore`, over real HTTP. PUT her
library → 200 on GET. PUT the poison → 204. GET → 500.

---

## 3. A Sync Baseline written by the previous build kills sync for good

**What is lost:** not phrases directly — sync itself, permanently, on the first
launch after any app upgrade that bumps the schema. Her library stops leaving
the phone, and the app tells her to update an app she has just updated.

**Where:**

- `src/adapters/storage/sync-baseline-store.ts:29` — the baseline is a whole
  `Library` envelope persisted under the `syncBaseline` key
- `src/adapters/storage/sync-baseline-store.ts:42` — read back raw, with no
  `normalizeLibrary` in front of it
- `src/adapters/storage/database.ts:120-134` — the IDB upgrade path migrates only
  records in the `decks` store; the `settings` store is never rewritten
- `src/adapters/sync/sync-engine.ts:217` — `baseline = await deps.baseline.read()`
- `src/domain/library-merge.ts:90-94` — throws when `base.schemaVersion !== local.schemaVersion`
- `src/adapters/sync/sync-engine.ts:239-246` — the throw sets `refused = true` → `unreadable`
- `src/adapters/sync/sync-engine.ts:313-315` — `unreadable` → `needs-update`, which does not retry

**Sequence:**

1. `CURRENT_SCHEMA_VERSION` goes 6 → 7. It has moved five times already
   (`migrations.ts:20-38`), always coupled to a new object store, and it will
   move again.
2. The IDB upgrade runs. Decks are migrated. The baseline, sitting in the
   `settings` store, is not — nothing migrates it, and nothing normalizes it on
   read.
3. The first round-trip normalizes `local` and `remote` up to 7 and hands
   `mergeLibraries` a baseline at 6. `library-merge.ts:90` throws
   `cannot merge libraries at different schema version: 7 and 6`.
4. `roundTrip` maps that to `unreadable`, the engine emits `needs-update`, and
   **schedules nothing** — `needs-update` is by design the state that never
   retries, because retrying the same build gets the same answer.
5. It is permanent. Nothing in the app rewrites or clears the baseline outside
   `libraryRestored()`, so no launch, no reconnect and no edit recovers it. She
   reads "Saved on this phone · update the app to sync" forever.

**How it was demonstrated:** `sync-baseline-upgrade.audit.test.ts`. Test 1 calls
the real `mergeLibraries` with a baseline one version behind and shows it throws.
Test 2 runs the real engine with such a baseline on disk and shows the state is
`needs-update` with an empty timer queue.

This is ranked below #1 and #2 because it loses no Phrase by itself. It is ranked
above the rest because it needs no race, no second device and no unusual input —
it fires for every user on the next schema bump, and it silently removes the only
thing keeping her library alive anywhere but one phone.

---

## 4. Inside the archive throttle a wipe replaces the only server copy

**What is lost:** up to an hour of her editing — every Phrase added since the
session's first push — from both `libraries` and `library_versions`. The server
then holds neither the good copy nor a history row containing it.

**Where:**

- `server/db.js:124` — `if (archivedAt === null || now - archivedAt >= intervalMs) {`
- `server/db.js:99-101` — "there is no route or script that can replace the only
  off-device copy of her library by forgetting a step"
- `server/db.js:113-118` — the documented bound: "lose up to an hour of edits"

**Sequence:** the window is measured from the last *archive*, and archives happen
only on puts. Her sync debounce is 2 seconds (`sync-engine.ts:107`), so an
editing session is a burst of pushes. The first archives; every one after it for
an hour archives nothing. A destructive push inside that window overwrites
everything the session produced with no history row behind it.

The one-hour bound is documented and deliberate (`db.js:113-118`,
`docs/server.md`). What is not true is `db.js:99-101`'s stronger claim that no
path can replace the only copy: inside the window, that is exactly what happens,
and that sentence is what a future change will be read against.

**How it was demonstrated:** `server/library-store-concurrency.audit.test.js`,
second test — the real `createLibraryStore` with the production one-hour interval.
A week-old push, thirty session pushes two seconds apart, then a wipe. The live
row is empty and the only archived version is the week-old one; `phrase 30`
exists nowhere.

---

## 5. One unbounded `schemaVersion` locks every device out of sync

**What is lost:** sync on both phones, permanently, after her library has already
been overwritten by the offending push.

**Where:**

- `server/app.js:45` — no upper bound on `schemaVersion`
- `server/app.js:360` — `if (stored && parsed.schemaVersion < storedSchemaVersion(stored.data)) {`
- `src/adapters/sync/library-sync-client.ts:63` — 409 → `stale-client`
- `src/adapters/sync/sync-engine.ts:313-315` — `stale-client` → `needs-update`, no retry

**Sequence:** any push carrying `schemaVersion: 999` — a buggy build, a replayed
body, a hand `curl` with her token — is accepted and stored, overwriting her
library. Every subsequent honest push from a real device carries 6, trips
app.js:360, and gets 409. The engine maps that to the one state that stops
retrying and tells her to update the app. No app update exists that would help.
The gate that exists to protect her from an old client is the thing that locks
out every client.

**How it was demonstrated:** `server/library-envelope.audit.test.js`, second test
— real server, real store, over HTTP. Her library → 204. `schemaVersion: 999` →
204. Her library again → 409.

---

## 6. Two simultaneous pushes drop one, and do not archive it

**What is lost:** one device's push in its entirety, from both the live row and
the version history. Usually repaired by that device's next round-trip; permanent
for anything it never gets to push again.

**Where:**

- `server/app.js:359` — `const stored = await libraryStore.get(key)`
- `server/app.js:369` — `await libraryStore.put(key, JSON.stringify(parsed), Date.now())`
- `server/db.js:121` — `const previous = await get(key)`
- `server/db.js:135` — the `INSERT … ON CONFLICT … DO UPDATE`

Read and write are separate awaits at both levels, with no transaction, no
`SELECT … FOR UPDATE`, and no compare-and-swap on `updated_at`. Both her phones
sync on the same triggers — launch, reconnect, the phone being locked — so
simultaneous pushes are the ordinary case, not the exotic one. Worse, both
concurrent puts see the same `previous`, so the history gets that one value
twice and the loser's content is archived nowhere.

The same window also makes the stale-client gate at app.js:360 racy: it reads a
row another request is about to replace.

**How it was demonstrated:** `server/library-store-concurrency.audit.test.js`,
first test — the real store, two `put`s in flight at once. The live row holds
`pB`, the history holds `p0` twice, and `pA` is in neither.

Ranked below the others because the losing device still holds its own copy and
the next round-trip repairs it. It is permanent only if that device never syncs
again — lost, wiped, reinstalled, or its IndexedDB evicted first.

---

## 7. A database that cannot be read at launch says nothing at all

**What is lost:** nothing directly. What she sees is a blank screen on the app
holding phrases that exist nowhere else, with no message and no control — the
same picture as "everything is gone". The path a non-technical user takes from
there is delete and reinstall, and on iOS that discards the origin's storage for
real.

**Where:**

- `src/App.tsx:214` — `void Promise.all([deckStore.loadAll(), mixStore.loadAll()]).then(([loadedDecks, loadedMixes]) => {`
- `src/App.tsx:243` — the same shape on the `libraryRevision` re-read
- `src/App.tsx:752-754` — `if (decks === undefined) return <main className="screen" />`

One-argument `.then` on both. No rejection handler. Every *write* in the
composition root goes through `persistLocally` (`App.tsx:345-353`), which has
both halves of the T069 contract — roll the screens back, and say which change
did not survive. The reads have neither.

`databaseTrouble` does not cover this. It reports exactly two conditions,
`blocked` and `terminated` (`database.ts:70`) — the two IndexedDB signals
delivered through a callback. An `openDB` that *rejects* reaches neither: a
`VersionError` from a rolled-back build meeting a database a newer build already
upgraded, a refusal under storage pressure, a corrupt store. Those arrive as a
rejected promise and land here.

`RestoreControl` — the one control that exists for exactly this moment, described
in its own doc comment as belonging on "the screen a wiped or replaced phone
actually opens on" — never renders, because `decks === undefined` returns first.
She cannot restore her way out.

**How it was demonstrated:** `src/App.launch-read.audit.test.tsx` renders the real
`App` with a deck store whose every method rejects. No `write-failure` notice,
empty `textContent`, no `restore-backup` button. Vitest also reports the
unhandled rejection from `App.tsx:214`.

---

## Suspicions — NOT demonstrated

Reported separately and deliberately unproven. Each would need a real iOS Safari,
a real Postgres, or a real deploy to settle.

1. **`downloadFile` revokes the blob URL synchronously after `click()`**
   (`src/App.tsx:116-123`), on an anchor never added to the document. WebKit is
   known to abort downloads revoked this eagerly. `handleExportBackup`
   (`App.tsx:519-521`) then calls `recordExport()` unconditionally, which resets
   the Backup age. If the download did not happen, the one indicator that tells
   her her library is not safe anywhere else has been silenced by an export that
   produced no file. Needs Safari to settle.

2. **The backup-file effect has no `.catch()`** (`src/App.tsx:316-330`). A failed
   `syncedLibrary.readLocal()` leaves the previous `backupFile` in place, and
   `handleExportBackup` will share it and record a fresh export against it. The
   staleness is bounded by the session, so this is a smaller version of #1.

3. **No `pool.on('error')`** anywhere in `server/`. `server/index.js:36` creates
   the pool and nothing subscribes. `pg` emits `error` on an idle-client or
   backend failure, and an unhandled `error` event terminates the process — so a
   Postgres failover takes the app down mid-push rather than surfacing a 500.
   Availability, not corruption. Needs a real Postgres.

4. **An oversize library gets 413 and stalls silently forever.**
   `server/app.js:9` sets `LIBRARY_MAX_BODY_BYTES = 8 * 1024 * 1024`;
   `library-sync-client.ts:64` maps anything not 401/409 to `network`, so the
   engine retries on backoff indefinitely with no distinguishable message. 8 MB
   is roughly 6.5× the modelled maximum (`docs/scale.md`), so this is latent.

5. **A rolled-back deploy meets a database a newer build already upgraded.**
   `database.ts:119` opens at `CURRENT_SCHEMA_VERSION`; an older build opening a
   higher-versioned database gets a `VersionError` and the open rejects. That
   lands in finding 7's silent blank screen, and unlike a transient failure it
   does not clear until the deploy is rolled forward.

6. **Three `close()` methods end one shared pool** (`server/db.js:156-158`,
   `:305-307`, `:400-403`). `server/index.js:36-50` builds all three stores over
   one pool, so closing any one kills the other two. No production caller does
   this today, and `index.js` has no SIGTERM handler at all.

---

## Checked and found NOTHING wrong with

A clean area is a real result. Do not re-spend time here.

**`src/domain/library-merge.ts` — the merge itself.** Every branch of
`mergePhrases`, `reconcileDeck`, `reconcileMix`, `isDeleted`, `rewritten` and
`mergeTombstones` was traced against the rules in `docs/sync.md`. The asymmetry
at `library-merge.ts:242-243` looks wrong on sight — the `!localChanged` branch
returns `{ ...remote, phrases }` while the `!remoteChanged` branch returns a bare
`local`, discarding the merged phrase list — and it is correct: when `remote` is
unchanged from `base`, `mergePhrases` provably returns exactly `local.phrases`,
in `local`'s order. Every remote-only id takes the `samePhrase(before[0],
theirs[0])` branch and is dropped; every shared id takes the
`samePhrase(before[0], other)` branch and keeps `held`. The duplicate-id union
path preserves the same property. **The merge is not where the remaining loss
is.** Both merge-level defects found in this audit are in what is handed *to* it
(the baseline), not in what it does with it.

**IndexedDB transaction boundaries.** `update` (`indexed-db-deck-store.ts:90-114`),
`updateAll` (`:152-204`), `importAll` (`:206-228`), `remove` (`:123-131`) and the
mix store's `remove` (`indexed-db-mix-store.ts:44-52`) are each a single
transaction spanning every store they touch, with only synchronous work or
same-transaction IDB operations between read and write. IndexedDB serializes
readwrite transactions over the same stores, so there is genuinely no interleave
between her save and a merge, and no window for a partial write. T074 and T075
hold. `deckStore.save` and `mixStore.save` are get-then-put across two
transactions, but `save` is reachable only for a freshly minted id (`App.tsx:381`,
`:669`, `:687`) and the mix case is the documented whole-record trade.

**The IDB upgrade path** (`database.ts:118-195`). Every step v1→v6 is additive;
`migrations.ts:79-132` is a complete chain with a throwing placeholder at index 0
and a test pinning `DECK_MIGRATIONS.length` to `CURRENT_SCHEMA_VERSION`. The
`clipMeta` store is deliberately created empty rather than backfilled inside the
versionchange transaction (T072), which is the right call. Every `await` inside
`upgrade` is an IDB request, so the transaction cannot auto-commit early. An
interrupted upgrade aborts and re-runs on the next launch.

**`parseLibraryFile`** (`library.ts:38-104`). The version guard is on the
envelope, not on its contents; `needs-update`, `empty` and `invalid` each refuse
before anything is cleared. The only accepting-and-destructive case I could
construct is a file she genuinely exported when she had zero decks and at least
one tombstone, behind an explicit "This replaces everything currently saved"
confirmation.

**`settings-store.ts` and `sync-baseline-store.ts` sharing the `settings` object
store.** Both write by key (`settings-store.ts:91-98`, `sync-baseline-store.ts:47`),
neither enumerates the store, neither clears it. The baseline cannot be clobbered
by a settings write or vice versa. (Its *content* is finding 3; its *storage* is
clean.)

**`clip-cache.ts`.** Eviction can name only `CLIPS_STORE` and `CLIP_META_STORE`
(`:337-352`), so it structurally cannot reach a Deck. `reconcileIndex` (`:284-310`)
is bounded by `CLIP_META_BACKFILL_CHUNK`, resumable across an interruption, and
deletes only from `clipMeta`. T076's both-directions reconciliation is sound. A
concurrent-`put` race on the `totalBytes` counter can over- or under-evict, but
only Clips, which are derived and regenerable.

**`mapping.ts`.** `toRecord`/`fromRecord` and the Mix pair drop no field in either
direction.

**`error-log.ts`.** Capped at `ERROR_LOG_CAP = 50`, trimmed oldest-first on every
write. It cannot grow into her quota.

**Server, read and write paths** (from a dedicated pass over `server/`):
`readBody` truncation and abort — a partial body rejects before any store call,
and no truncation of a JSON object survives `JSON.parse`; JSON parse failures
return 400 before the store is touched; no 2xx is returned on a failed write;
`put`'s statement ordering (get → archive → prune → upsert) aborts before the
overwrite on every failure mode; GET serves the row byte for byte with no
re-serialization; there is no `DELETE`/`TRUNCATE`/`DROP` against `libraries`
anywhere in `server/` or `scripts/`; `pruneVersions` never makes index 0 a
candidate and provably terminates; the clip store names its tables literally and
cannot reach `libraries`; `retry.js` wraps provider calls only and never the
library write; `bounded-queue.js` decrements on both settle paths;
`static.js` bounds-checks against `distDir`; `scripts/restore-drill.mjs`
re-checks its prefix before any drop.

---

## Action items

1. **Finding 1 and finding 3 are one change**: the baseline needs to be owned by
   one writer with a version on it, normalized on read, and not writable by a
   round-trip that started before a restore. Both are the baseline being trusted
   as more durable than it is.
2. **Findings 2 and 5 are one change** in `server/app.js`: validate what will
   actually be *stored*, not what was parsed — `Number.isFinite` plus an upper
   bound against the build's own version.
3. **Finding 6** needs a transaction with `SELECT … FOR UPDATE` on the row, or an
   unconditional archive when a concurrent overwrite is detected.
4. **Finding 4**: reconcile `server/db.js:99-101` with what the throttle actually
   guarantees. The comment asserts an invariant the code does not hold.
5. **Finding 7**: give the two launch reads the same treatment `persistLocally`
   already gives every write.
