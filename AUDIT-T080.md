# AUDIT-T080 — adversarial audit of the eleven data-loss fixes

Scope: the six fixes named in the directive (T070, T071, T072, T074, T075, T076).
Method: read the code, not the commit messages; attack each claim; demonstrate every
break with a failing test against the real code.

**`npm test` fails with this audit present. That is the deliverable.**

```
Test Files  7 failed | 86 passed | 2 skipped (95)
Tests      18 failed | 1120 passed | 13 skipped (1151)
```

17 of those 18 are audit tests. The 18th, `pwa.build.test.ts`, is pre-existing and
unrelated — it shells out to `npm run build`, which does not run in this worktree.

Audit test files:

| File | Fix |
|---|---|
| `src/domain/library-merge.audit.test.ts` | T070 |
| `src/adapters/sync/sync-engine.audit.test.ts` | T070, T072 |
| `server/db.audit.test.js`, `server/app.audit.test.js` | T071 |
| `src/adapters/storage/clip-cache.audit.test.ts` | T076 |
| `src/adapters/storage/transaction-seam.audit.test.ts` | T074, T075 (evidence gap) |

---

## Ranking — what is lost, and how silently

| # | Fix | What is lost | Silence | Trigger |
|---|---|---|---|---|
| 1 | T071 | up to an hour of her phrases, from the server, unrecoverably | two HTTP 204s, zero log lines | one bad push inside the snapshot hour — **the typical case, not a corner** |
| 2 | T071 | the whole of one device's push | none at all | two devices pushing at once (the case sync exists for) |
| 3 | T070 | nothing deleted — but nothing syncs, ever again | tells her to update an app that is already current | the next schema bump, on every device that has ever synced |
| 4 | T071 | the shared clip store, permanently cold or unbounded | none | a malformed `CLIP_STORE_MAX_BYTES` env var |
| 5 | T072 | no Phrases — but every deletion she ever made is undone on both devices, permanently | the app says "nothing was replaced" | a restore whose local write fails |
| 6 | T070 | one whole Deck and every Phrase in it | none | a hand-edited backup with two Decks under one id |
| 7 | T076 | audio only (regenerable), for the rest of the session | Phrases silently report "ready" with nothing to play | a `QuotaExceededError` on one clip write |
| 8 | T076 | audio only, whole cache disabled for the session | drill readiness and the generation queue both go down | one transient IDB failure during the launch sweep |

---

## T070 — `src/domain/library-merge.ts`

Attacked with: no baseline at all; a baseline older than both sides; a Tombstone whose
record was edited on both sides; a Tombstone for a record in the baseline but in neither
side; duplicate Phrase ids; duplicate Deck ids; a wrong clock ahead of a live Deck; a
side unchanged from the baseline with the other side having deleted and edited Phrases.

### HELD

The core rule holds against everything I threw at it.

- **The other side's absence is never a deletion.** Confirmed. `mergePhrases` pushes
  `held` whenever this side has the Phrase and the other does not, on every path,
  baseline or no baseline. A Phrase can only be dropped where this device's own saved
  Deck agrees with the baseline that it is gone.
- **A Tombstone edited on both sides.** The merged Deck differs from the baseline, so
  `rewritten` is true, so `isDeleted` refuses, so the Deck survives and the Tombstone is
  dropped in the same pass. Resolves once, does not flap.
- **A Tombstone for a record in the baseline but in neither side.** Survives as a
  Tombstone, deletes nothing that exists. Correct.
- **Duplicate Phrase ids.** `unionByContent` keeps both sides whole. Nothing is dropped
  and only exact repeats are folded.
- **No baseline.** Degrades to a union. A local deletion is undone, no Phrase is lost.
  Documented and true.
- **`reconcileDeck`'s `if (!remoteChanged) return local`** returns the raw local record
  without the merged `phrases`. I tried to make that lose a Phrase and could not: if
  remote is unchanged from the baseline, every Phrase it holds that local does not is
  also unchanged from the baseline, and `mergePhrases` correctly reads that as a local
  deletion. The two answers are the same. Sound, but it is the one place in the file
  where the shortcut is not obvious from reading it.

### BROKEN — finding 1: the Sync Baseline is never migrated, and T070 added a throw for it

`mergeLibraries` now refuses when `base.schemaVersion !== local.schemaVersion`. The
Sync Baseline is a whole `Library` persisted verbatim (`sync-baseline-store.ts` — plain
`db.put`/`db.get`) carrying the version that was current when it was written. **Nothing
migrates it, and `sync-engine.ts` normalizes the local and remote envelopes but not the
baseline.**

So the first bump from schema 6 to 7 leaves every device that has ever synced holding a
v6 baseline against a v7 local library. The throw fires on every round-trip. The engine
cannot distinguish it from an envelope written by a newer build, so it maps to
`unreadable` → `needs-update` and **stops pushing, permanently, on a phone that is
already running the newest build.** Nothing is deleted; nothing leaves the phone either,
which is the failure sync exists to prevent — and the only signal is a line telling her
to do the one thing that will not help.

- `src/domain/library-merge.audit.test.ts` — *a baseline written by an older schema
  version does not kill the merge*
- `src/adapters/sync/sync-engine.audit.test.ts` — *a baseline left behind by the previous
  schema version does not stop sync for good*

This is a defect T070 introduced. Before it there was no baseline version check.

### BROKEN — finding 6: duplicate Deck ids are unguarded

`mergePhrases` reasons explicitly about two Phrases sharing an id ("a hand-edited restore
file, an import bug — no write path enforces uniqueness") and keeps both rather than
dropping one of hers. The same reasoning is not applied one level up: `mergeDecks` merges
two Decks sharing an id independently and emits both. `updateAll`/`importAll` then write
them with `deckStore.put` into a store keyed by `id`, so the second silently overwrites
the first and every Phrase in it is gone.

Reachable by exactly the route `mergePhrases` names: `parseLibraryFile` validates each
deck record but never checks id uniqueness, so a hand-edited or concatenated backup
restores with one Deck destroyed and no message.

- `src/domain/library-merge.audit.test.ts` — *two Decks sharing an id are not left for
  the store to collapse*

---

## T071 — `server/db.js`, `server/app.js`

Claims: (a) a push never destroys what it replaces; (b) the clip store is bounded.

Attacked with: the snapshot throttle; `pruneVersions` under every combination of count
and byte budget including 0, −1 and NaN; a crash injected between the archive INSERT and
the overwrite; two overlapping pushes; malformed env vars. All against the in-memory pool
`server/db.test.js` already uses, so every test runs without Postgres.

### BROKEN — finding 1 (worst in the audit): the throttle window is unprotected

Claim (a) is false as written. Inside the hour window, `put` destroys the version it
replaces and archives nothing.

```
09:00  push, 400 phrases            (A)
10:00  push, 500 phrases            (GOOD)  — an hour has passed, A is archived
10:01  push, truncated/empty        (BAD)   — 60s < 1h, NO archive, GOOD overwritten
10:02  another bad push                     — still throttled
```

`versions()` returns `[A]`. GOOD is gone. Recovery reaches 400 phrases; the 100 added
between the two archive points are unrecoverable.

The part that makes this the normal case: the client debounces at 2 s and pushes on every
local edit, so an hour of ordinary use produces ~1800 pushes and **exactly one archive —
of the state at the first push.** Every state after it is unprotected. A bad push has
roughly a 1-in-1800 chance of being the one that gets archived.

End to end over real HTTP: `{format, schemaVersion, decks: []}` passes
`isLibraryEnvelope`, returns 204, and destroys the 900-phrase state it replaced.
`GET /api/library` then serves `{decks: []}` with a 200. **500 phrases lost, two 204s,
zero log lines.**

- `server/db.audit.test.js` — `P1`, `P1b`
- `server/app.audit.test.js` — `A1`

### BROKEN — finding 2: archive and overwrite are not one transaction, and two devices race

`grep -rn "BEGIN\|COMMIT\|ROLLBACK\|connect()" server/` returns nothing. Every statement
goes through `pool.query`, which takes an arbitrary pooled connection and autocommits.
The read, the archive INSERT, the prune DELETE and the overwrite are four separate
transactions on potentially four different connections.

A crash between the archive and the overwrite is survivable (`P3` passes — the ordering
argument in the docstring is correct). A concurrent push is not:

- Both devices hold BASE.
- Phone's `put(FROM_PHONE)` reads `previous = BASE`, then stalls after the SELECT.
- iPad's `put(FROM_IPAD)` completes: archives BASE, stores FROM_IPAD.
- Phone resumes with its stale `previous`, and the throttle now suppresses its archive
  anyway. It writes FROM_PHONE.

FROM_IPAD is destroyed and never archived. **This break survives a fix to the throttle** —
the read-modify-write raced, so the phone would archive BASE a second time, still not
FROM_IPAD.

- `server/db.audit.test.js` — `P3b`, `P3c`

### BROKEN — finding 4: the clip-store bound is off when the env var is malformed

`server/index.js:48` is `Number(env.CLIP_STORE_MAX_BYTES ?? DEFAULT_...)`. Nothing
validates the result.

- `CLIP_STORE_MAX_BYTES=300MB` → `NaN`. Every comparison against NaN is false, so
  `evictIfOverBudget` returns immediately, forever. **The bound is silently off** — no
  throw, no log, no metric — and `clips` grows until the disk fills, at which point the
  write that starts failing is `libraryStore.put`: exactly the failure the bound exists
  to prevent.
- `CLIP_STORE_MAX_BYTES=` (a blank field in the Render dashboard) → `''`, which is not
  nullish so `??` never applies, and `Number('')` is `0`. Every `put` then evicts the
  entire table including the clip just written. The shared clip store is permanently
  cold and every phrase is re-billed to ElevenLabs on every request.

- `server/db.audit.test.js` — `P4`, `P4b`

### HELD

- **Count and byte budgets cannot prune to zero.** `pruneVersions` does
  `if (index === 0) return` before either budget test, so the newest archived row is
  exempt unconditionally. Tried `versionMaxCount` 0 and 1, `versionMaxBytes` 0, −1 and
  NaN, in every combination. At least one version always survives. `P2` passes.
- **A crash between the archive INSERT and the overwrite** leaves the previous version
  intact and archived. `P3` passes.
- **The eviction sweep itself** is correct with a valid ceiling. `P4c` passes.

### Latent, not reachable today

`P2b` — if the newest archived row alone exceeds `versionMaxBytes`, the prefix sum dooms
every older row at index 1 and the history collapses N→1 in one DELETE. Not reachable
with the shipped constants (`LIBRARY_MAX_BODY_BYTES` 8 MB caps a stored envelope,
`LIBRARY_VERSION_MAX_BYTES` is 32 MB and not env-configurable). It goes live the moment
either constant moves. Related fact worth writing down: at the 8 MB body cap the byte
budget binds at **4** retained versions, not 72 — "three days of history" is three days
for a small library and four hours for a large one.

---

## T072 — `src/adapters/storage/database.ts`, `clip-cache.ts`, `sync-engine.libraryRestored`

Attacked with: the baseline write succeeding and the local write then failing; what the
next sync does with an empty baseline against an intact server; whether
`nothingIsAgreed()` is distinguishable from a genuinely empty library.

### HELD

- **The upgrade no longer reads the clip store inside a versionchange transaction.**
  Confirmed by reading `database.ts`: `CLIP_META_STORE` is created empty and nothing is
  backfilled in the upgrade. The backfill is `reconcileIndex`, outside the transaction,
  in bounded chunks.
- **Empty vs absent is a real distinction and the merge honours it.** With an empty
  baseline, `rewritten` returns true for every record (`base.get(id)` is `undefined`), so
  no Tombstone can delete anything and every restored record survives. With an absent
  baseline, `rewritten` returns false and a Tombstone wins on its clock alone. The two
  are genuinely different code paths and `nothingIsAgreed()` reaches the right one.
  Control test passes.
- **`nothingIsAgreed()` vs a genuinely empty library.** Not confusable in practice: a
  never-synced device has an *absent* baseline, and after the first successful push the
  baseline holds real records. I could not construct a case where the two are mistaken
  for each other.
- **Baseline written, local write fails, next sync.** No Phrase is lost. The merge
  becomes a union and the baseline is repaired on the next successful push.

### BROKEN — finding 5: a failed restore silently and permanently undoes her deletions

`handleConfirmRestore` awaits `libraryRestored()` **before** `writeLocal`, on the
argument that "a restore applied on top of an intact baseline is the defect happening".
True — but the reverse is now possible and nothing undoes it. When `writeLocal` fails,
the baseline has already been set to empty and stays that way.

`App.tsx` then shows *"That backup could not be restored on this phone"* and its comment
claims *"nothing was replaced, and the Decks she had are still the Decks she has"*. The
Decks are. The baseline is not.

An empty baseline makes every record on both sides read as written since the last
agreement, so the next round-trip drops every Tombstone the server holds and resurrects
every Deck she has ever deleted — on both devices, permanently — from an operation the
app reported as having done nothing.

- `src/adapters/sync/sync-engine.audit.test.ts` — *a restore whose local write fails does
  not leave the baseline emptied*
- `src/adapters/sync/sync-engine.audit.test.ts` — *an emptied baseline from a failed
  restore does not undo a deletion made elsewhere*

Ranked below the loss findings because no Phrase dies. It is here because it is silent,
cross-device, irreversible, and directly contradicts the comment that justifies the
ordering.

---

## T074 — `updateAll`, `synced-library.ts`

Attacked with: does the transaction span all three object stores; what happens when
`update` throws; can `sameLibraryContent` skip a write it should have made; the pinned
voice; a save landing between the read and the write.

### HELD

- **The transaction really does span all three stores.** `db.transaction([DECKS_STORE,
  MIXES_STORE, TOMBSTONES_STORE], 'readwrite')`, and every step between the read and the
  write is synchronous or an operation on that same transaction. The merge runs inside it.
- **`update` throwing** aborts rather than writing a guess, and reads `tx.done` so the
  abort does not surface as an unhandled rejection.
- **The skip-when-unchanged path does not miss a change.** `sameLibraryContent` ignores
  `exportedAt` and the pinned voice; both omissions are correct. `exportedAt` is stamped
  at read time so including it would report a change on every call. The voice does not
  live in the deck store, so skipping the *deck store* write is right — and
  `updateLocal` re-adds it to the answer (`result.changed || !sameVoice(...)`) and calls
  `adoptVoice` unconditionally. I tried to construct a voice change that gets lost
  through the skip and could not.
- **A local save racing the merge.** Under real IndexedDB semantics a `save()` is its own
  transaction and cannot interleave with an open readwrite transaction over the same
  store: it either commits before `updateAll` reads or after it writes. I could not
  construct a third outcome.

### Evidence gap (not a defect claim)

Every one of those guarantees rests on IndexedDB transaction semantics, and **the `idb`
test double provides none of them.** `src/adapters/storage/idb.test-support.ts`:

```ts
done: Promise.resolve(),
abort: () => {},
```

Every operation is applied to the backing `Map` the moment it is called, `abort()` does
nothing, `done` is already settled, and `transaction()` ignores its scope and takes no
locks. So the double cannot distinguish the fixed code from the code before the fix on
the property the fix is *about*. `sync-round-trip-race.test.ts` passes because it injects
her save inside `baseline.read()` — before `updateLocal` is even called — which pins that
the read happens late, not that read-merge-write is indivisible.

Three tests assert the properties the claims need. They fail. Real IndexedDB provides all
three, so **this is not evidence the app is broken** — it is evidence the guarantee is
unwitnessed: move the `getAll` out of the transaction tomorrow and every existing test
still passes.

- `src/adapters/storage/transaction-seam.audit.test.ts` — all three

The third of those has a practical edge: `App.tsx` tells her "nothing was replaced" when
`importAll` rejects, and under the double the decks store is already cleared and
rewritten by the time a later store's write fails. That sentence is asserted by nothing.

---

## T075 — `mutateDeck`, `DeckStore.update`

Attacked with: the fallback when the Deck is gone from the store; `save` still being used
for new Decks; `apply` running twice; `persistMix`; a resurrected Deck against its
surviving Tombstone.

### HELD

- **The fallback resurrects nothing it should not.** `apply(stored ?? base)` reaches
  `base` only when the Deck is absent from the store, and a Deck absent from the store
  has no Phrases to drop. What it resurrects is a Deck deleted on the other device, which
  costs her one tap — the trade the file states.
- **A resurrected Deck outlives its own Tombstone correctly.** `update` writes the Deck
  but not the Tombstone, so both are present locally. The next merge finds the Deck
  absent from the baseline, reads it as written since, keeps it, and drops the Tombstone.
  It resolves once. I checked the mirror case on the other device too.
- **`save` cannot collide.** Every caller (`handleCreateDeck`, `handleImportSave`'s
  new-Deck branch, `persistNewDeck`) passes a `crypto.randomUUID()` minted moments
  earlier. `save`'s get-and-put across two transactions is safe for that reason, and only
  for that reason — it is one refactor away from being unsafe.
- **`apply` running twice is safe at every call site**, because every caller that mints
  an id does it *outside* the callback (`handleImportSave`, `handleAddCandidates`,
  `onAddPhrase` all do this deliberately, with a comment). A future caller that mints
  inside the callback would write two different ids to the screen and the store, and
  nothing structural prevents it.
- **`persistMix` was deliberately not fixed**, and the scope is correctly argued: a Mix
  holds Deck ids, never Phrases, and the write names one Mix so it can reach no other
  record. The loser of a Mix race is a selection she re-makes in seconds. I could not
  make it lose anything else.

Nothing broken. The atomicity of `update` itself carries the same evidence gap as T074
(above).

---

## T076 — `src/adapters/storage/clip-cache.ts`

Attacked with: is the launch sweep reachable on every path; can reconciliation be
interrupted into a worse state; a failed clip write; a failed delete mid-sweep.

### HELD

- **The launch sweep is reachable.** `getIndex()` is on `put`, `has`, `readyPhraseIds`
  and `usage`, and on `get` whenever a Clip is found. Nothing plays or generates audio
  without passing through it.
- **The ordering claim in `evictDownToTarget`'s doc comment is correct.** `indexPromise`
  really is assigned before the async body's first `await` returns, so the launch sweep
  running from inside `getIndex`'s own build does not deadlock on the promise it is
  settling. I checked this rather than taking it.
- **Interrupted reconciliation does not get worse.** Orphan rows are deleted first, then
  the backfill is driven off the difference between the two stores, so an interrupted run
  leaves the rows it managed and the next launch does the rest. `clipMeta` is derived, so
  a deleted row loses nothing. Control test passes.
- **Keys, not a count.** The fix to the old `count() <= known.length` test is right: one
  orphan used to cancel one unindexed Clip exactly, and that Clip was never indexed on
  any launch.

### BROKEN — finding 7: a refused clip write leaves a ghost in the index for the session

`put` mutates the in-memory index and `totalBytes` **before** it writes anything:

```ts
index.set(clip.hash, meta); totalBytes += meta.bytes
await db.put(CLIPS_STORE, clip)      // <- QuotaExceededError here
```

When that write rejects, the row is never persisted but the in-memory index keeps it for
the rest of the session. `has()` is answered from the index, so it answers `true` for
audio that does not exist; `readyPhraseIds` therefore reports the Phrase as drillable and
the generation queue never re-enqueues it, while `get()` returns `undefined` and there is
nothing to play. `totalBytes` is also permanently inflated by a Clip that was never
stored, so the next sweep evicts real audio to make room for it.

`reconcileIndex`'s comment claims both directions of drift self-heal. They do — on the
next *launch*. Within the session that created the drift, nothing does. And
`QuotaExceededError` on a phone under storage pressure is precisely the condition the
200 MB ceiling exists to survive.

- `src/adapters/storage/clip-cache.audit.test.ts` — *a clip whose write was refused is
  not left in the index as present*

### BROKEN — finding 8: one transient failure disables the cache for the session

`getIndex` memoizes `indexPromise` with `??=`, and the whole of the launch work —
`reconcileIndex` plus `evictDownToTarget` — runs inside that one promise. Nothing is
guarded, and every step is an unguarded `db.delete`/`db.put`/`db.get`. One transient
IndexedDB failure anywhere in there leaves `indexPromise` permanently **rejected**, and
the memo is never cleared.

From that instant every `has()`, `put()`, `readyPhraseIds()` and `usage()` rejects for
the rest of the session — and the composition root makes exactly one cache. The drill
readiness sweep and the generation queue both go down with it. Only relaunching clears
it, and nothing on screen says so.

This is the same failure shape T076's own doc comment worries about ("a hang with no
timeout, on the index every screen waits for"), reached by rejection rather than deadlock.

- `src/adapters/storage/clip-cache.audit.test.ts` — *one failed delete during the launch
  sweep does not disable the cache for the session*

Both are audio-only — a Clip is regenerable and a Phrase is not — which is why they rank
last.

---

## Suspicions (no failing test — do not act on these as findings)

- **`handleLibraryPut` re-serializes.** It stores `JSON.stringify(parsed)`, while
  `handleLibraryGet`'s comment claims the body is "served byte for byte, not
  re-serialized … nothing this server does can quietly reshape it". True of the read,
  false of the write. No payload the app produces loses data through the round trip
  (integers past 2^53 would; no field carries one), so this is a docstring/behaviour
  mismatch I could not turn into loss.
- **`evictIfOverBudget` throwing is swallowed** at `server/app.js:210`
  (`logger.warn('could not store generated clip')`) after the INSERT has committed. A
  persistently failing DELETE would leave the store growing behind a warn line.
- **A Deck Tombstone and a Mix Tombstone sharing an id collide** in `TOMBSTONES_STORE`,
  which is keyed by `id` alone while the domain namespaces by `kind:id`. One deletion
  silently overwrites the other. Not reachable with UUIDs; recorded because the
  domain/storage key mismatch is real.
- **`fingerprint`'s sort comparator never returns 0** (`x.id < y.id ? -1 : 1`), so with
  duplicate ids the ordering is input-dependent. Only matters if finding 6 is left open.
- **`onMovePhraseUp`/`onMovePhraseDown` recompute the index against the stored Deck**,
  which may hold Phrases in a different order than the screen. Not a loss — the screen
  reconciles from `saved` — but the reorder she sees is not always the reorder that lands.

---

## Action items

1. **T071 finding 1 and finding 2 are one claim failing two ways.** A fix to the
   throttle alone leaves the concurrent-push break live. Both need addressing, and the
   concurrent one needs a transaction or a compare-and-set, not a longer window.
2. **T070 finding 1** is a live time bomb with a fixed fuse: it detonates on the next
   schema bump, on every device. Normalizing the baseline on read is the obvious answer;
   whatever is chosen, it must be decided before schema 7 ships.
3. **T071 finding 4** is one missing `Number.isFinite` check on an env var, with an
   order-of-magnitude difference in blast radius between the two spellings.
4. **T074/T075 evidence gap.** Decide whether to teach the `idb` double about
   transactions or to run these paths against `fake-indexeddb`. As it stands the two most
   important atomicity guarantees in the app are asserted by nothing.
5. **`P2b`** is latent. Put a note in `db.js` so a future change to
   `LIBRARY_MAX_BODY_BYTES` or `LIBRARY_VERSION_MAX_BYTES` does not activate it unseen.
