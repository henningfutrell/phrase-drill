# Sync (T034)

Her library lives on two devices and one server. She is not technical, has no
physical access to her own phone, and has been burned once by losing saved
work. So sync has no controls, no "sync now", and no state she has to
understand — and one hard rule underneath it:

> **"Nothing happened" is acceptable. "Everything is gone" is not.**

Everything below follows from that.

## When a sync happens

Event-driven. Nothing polls.

| Trigger                    | Why                                                                            |
| -------------------------- | ------------------------------------------------------------------------------- |
| App launch                 | The one moment guaranteed to happen. It is how a change made offline yesterday reaches the server today. |
| Any local change           | Debounced, see below.                                                            |
| The device comes back online | Only when there is something outstanding — an idle engine that reconnects spends nothing. |
| The app is backgrounded    | She locks the phone right after typing. Flushes the debounce window instead of stranding the change until the next launch. |
| After a failed round-trip  | Retry with backoff: 5s, 15s, 60s, then 5 minutes repeating. Skipped entirely while the device reports itself offline — the reconnect event ends that wait. |

**The debounce is 2 seconds** (`DEFAULT_DEBOUNCE_MS`). A burst of edits —
accepting five translated candidates, fixing one phrase and immediately fixing
the next — collapses into one round-trip instead of five, which is five radio
wake-ups saved per burst on a phone. Two seconds is short enough that the push
is in flight before she has navigated anywhere, and both cases where it would
still be too long are covered without polling: backgrounding flushes it, and a
launch always syncs.

A sync that succeeds and is followed by no change makes **no further
requests**. There is no heartbeat.

## What one round-trip does

`src/adapters/sync/sync-engine.ts`, in order:

1. **Pull.** If the pull fails for any reason other than `not-found`, stop —
   without the server copy this device cannot know what a push would
   overwrite. Her change stays on the phone and goes up next time.
2. **Read the baseline.** Written by this engine and by nothing else, so it
   races with nobody.
3. **Merge and write it back locally, as one indivisible step, before
   pushing** — `updateLocal`, below. `mergeLibraries(local, remote, baseline)`
   merges, never replaces, and `local` is what is stored at the instant of the
   write. If the push then fails, what came down from the other device is
   already saved here.
4. **Push the merge.** It is a superset of what the server held, so a push can
   add records and never remove one.
5. **Only then** record the baseline and the sync time.

`lastSyncAt` is written by step 5 and by nothing else, so a failure can never
report a time and the sync line can never say "Synced" about a round-trip that
did not complete.

### The read and the write are one step (T074)

Step 3 used to be two: `readLocal()`, then merge, then `writeLocal()`. She is
holding the phone, and a round-trip is not instant. **Anything she saved
between that read and that write was computed away** — the merge came from a
snapshot that predated her keystrokes, and `importAll` clears all three object
stores and rewrites them from it. The Deck was gone from IndexedDB, absent
from the push, and nothing was said. `src/adapters/sync/sync-round-trip-race.test.ts`
runs the whole thing against the real storage adapters and pins it.

So the sync path writes through **`DeckStore.updateAll`**, which does the read
and the write in **one IndexedDB transaction**: the update function is handed
what is stored at that instant. Her `save` is its own transaction, so it either
commits before this one reads — and is merged in — or after this one writes —
and stands. There is no third outcome and no snapshot old enough to lose. The
update must be pure and synchronous, because the transaction is held open
across it; anything awaited in there would reopen the window it closes.

`updateAll` also reports whether it wrote anything, which is what the library
revision counts, and it **skips the clear-and-rewrite entirely when the merge
changed nothing**. That is not an optimization: a wholesale clear on every idle
sync is a wipe waiting for the one transaction that does not finish.

Two other shapes were considered and rejected:

- **Re-read and re-merge just before the write, with a bounded retry.**
  Optimistic, stays inside the engine, needs no change to any port — and leaves
  the same defect in a narrower window, because the re-read and the write are
  still two transactions. A defect that is merely harder to hit is still the
  defect, and it would have been retired as fixed.
- **A lock, or a generation counter, over the local library.** A lock has to be
  held across IndexedDB awaits and would have to be bypassed by the engine's own
  write to avoid deadlocking on itself — two routes to one store under different
  rules. A counter has to be incremented by every writer, and this library has
  more than one: the deck store and the mix store write different object stores
  of the same envelope, so a counter owned by either is blind to the other. A
  *persisted* counter would be a schema change to data that is hers, which needs
  a migration or does not happen. `updateAll` compares nothing and locks nothing
  — it reads the real records at the moment it writes them.

**Nothing was added to what is stored.** `updateAll` is a new way to write the
same three object stores; no field, no version bump, no migration.

The **pinned voice** is the one thing not inside the transaction. It lives in
the `settings` store, reached through a different connection, and no
transaction can span both — so `updateLocal` reads it before the transaction
opens and adopts the merged one after it closes. A voice she changes in that
window can still be overwritten. It costs one tap in Settings (T067), and it is
not a Phrase.

### Her save is one step too (T075)

T074 closed the window inside the round-trip. The same window was still open
one level up, in the composition root, and it was worse there.

`App.persist` wrote a whole `Deck` **built from React state**. React state is a
view of the library, and a view is stale by the time a tap reaches storage: the
merge writes a Phrase from her other phone between the render she tapped and
the write it caused, and the rendered Deck is then put back over the merged one.
The `libraryRevision` effect re-reads the stores, but an edit already in flight
against the old snapshot still lands after it.

The escalation is what made this data loss rather than a refresh bug. After the
overwrite the **Sync Baseline holds that Phrase and the local Deck does not**,
and `mergePhrases` reads exactly that as *this device deleted it* (T070). So
the next round-trip removes the Phrase from the server as well. One dropped
render becomes a permanent deletion on both phones.

So a change to a Deck that already exists writes through **`DeckStore.update(id,
apply)`** — the same shape as `updateAll`, at the scale of one Deck. The store
reads the Deck and puts the result in one transaction, and `apply` is handed
what is stored at that instant, never the Deck the render computed. `apply` is
a pure domain function (`addPhrase`, `updatePhrase`, `renameDeck`,
`reorderPhrase`, …), so it is run twice: once against the rendered Deck to
change the screen immediately, once inside the transaction to decide what is
written. The store's answer replaces the screen's as soon as it lands, so the
merged Phrase appears without waiting for the next sync.

- **`save` still exists, and is now only for a Deck that does not exist yet** —
  a freshly generated id with nothing stored under it to overwrite. That is the
  one condition under which a whole-Deck put is safe.
- **Her edit is never dropped to protect the merged Phrase.** A Deck the store
  no longer holds (deleted on the other phone, or by the merge) falls back to
  what is on screen, so the edit lands and resurrects the Deck — one tap to
  delete again, consistent with T070's rule that an edit outranks a delete.
- **Nothing was added to what is stored.** `update` is a new way to write the
  `decks` object store; no field, no version bump, no migration.

`src/App.test.tsx` (`a save made while a merge is landing`) drives the real
App, the real merge and the real round-trip with her write held in flight, and
pins both halves: the merged Phrase survives on this phone and on the server,
and so does hers.

**Saved Mixes are not covered by this**, deliberately. `persistMix` still puts a
whole Mix built from React state, so a Mix she edits while a merge is landing
can lose the other side's *selection of Deck ids* — the same trade the merge
already makes for Mixes (see Known gaps). It cannot lose a Phrase, and it cannot
lose a whole Mix: the put names one Mix and touches no other record.

## The merge, and the Deck-level conflict T060 left open

`src/domain/library-merge.ts` is pure and has three layers:

- **Per record, last write wins** (T060). A Deck or Mix only one side holds is
  kept unconditionally; the same id on both sides resolves by `updatedAt`.
- **Tombstones** (T060) make a deletion travel as data, so a delete sticks
  instead of being pushed back by whichever device still holds the record.
- **Three-way per Phrase** (T034), against the **Sync Baseline**.

The baseline is the last snapshot this device and the server agreed on. With
it, "these two Decks differ" splits into the three answers that matter:

| Case                        | Result                                                                 |
| --------------------------- | ------------------------------------------------------------------------ |
| Only one side changed       | That side's name and dates win whole. Its **Phrases** still go through the merge below. |
| Both changed                | Merge per Phrase by id: additions from both sides are kept; a deletion applies only to a Phrase **this device** no longer holds and the baseline says it once did — **an edit outranks a delete**. |
| The same Phrase edited on both | The later Deck's text wins (a tie keeps local).                       |

**That last row is the only place a keystroke can still be lost**, and it is
deliberate: a `Phrase` has one French field and one English field, and
inventing a second copy of a phrase would corrupt the drill she is running.
Everything else — different Phrases of the same Deck, an add against a delete,
a rename against an edit — is preserved on both sides.

### A Phrase is removed only when something records the deletion (T070)

The audit in T068 found the merge reading "in the baseline, unchanged here,
absent there" as *the other side deleted it*. That inference holds only if the
other side descends from the baseline, and **the server is not guaranteed to**:
restoring the `pg_dump` (the documented recovery procedure — `docs/backup.md`),
an older device winning a concurrent push, or any hand repair of
`libraries.data` moves it backwards. Every Phrase added since that point, on a
Deck edited on either side, was then dropped from IndexedDB *and* from the
server in one round-trip, with no Tombstone. The recovery procedure was the
attack.

So: **the other side's absence is never a deletion.** Nothing writes a Phrase
Tombstone, and the one record of a Phrase deletion this build has is this
device's own saved Deck — it held the Phrase at the last agreed state and does
not now. The cost is that a Phrase deleted on the *other* device comes back
here until this device deletes it too: one tap, against handwritten phrases
that exist nowhere else.

Two Phrases sharing an id are both kept, never folded into one. No write path
enforces uniqueness, so a duplicate id is already a defect — answering it by
dropping one of her phrases would make it a loss.

**With no baseline** (the first sync ever, after IndexedDB eviction, or one
written under a schema version this build does not read — see below) a Deck
held by both sides keeps the later record's name and dates and the **union** of
its Phrases. A missing baseline degrades the merge; it never deletes through
it.

### Clocks (T070)

`updatedAt` and `deletedAt` come from two unsynchronized wall clocks, and
Tombstones are never garbage-collected, so one phone that has been off, in
airplane mode, or had its date set by hand could poison a record permanently.
There is no logical clock here and adding one would change what is on her disk.
What the merge has instead is the baseline, which is causal rather than
chronological: **a Tombstone deletes only a record that is unchanged from the
last state both sides agreed on** — anything rewritten since was written after
that agreement, whatever a clock says, so the deleting side cannot have seen
it. The Tombstone is then dropped, so this resolves once instead of flapping.
The same baseline test decides a Mix conflict before `updatedAt` is consulted.

What is left of the clock: with no baseline at all, it is the only ordering
there is, and a Deck can still lose to a skewed Tombstone for exactly one
round-trip. And where both sides genuinely changed a Deck or a Mix, the later
`updatedAt` picks the surviving **name** or Deck selection. Neither can lose a
Phrase any more.

The baseline is per-device, never sent anywhere, and lives in the `settings`
object store under the `syncBaseline` key
(`src/adapters/storage/sync-baseline-store.ts`) — a key rather than an object
store of its own, because a new store is a schema version bump and a migration
for every existing database, and this is derived data whose loss costs one
round-trip's precision.

### A baseline the last build wrote (T081)

Nothing migrates it. The IndexedDB upgrade path rewrites records in the `decks`
store only, the baseline store reads its value back raw, and the library beside
it *is* migrated — so the morning after any app update that bumps the schema,
the two are one version apart.

`mergeLibraries` used to refuse that outright. The engine read the refusal as
an envelope this build cannot understand and parked at `needs-update`, which by
design never retries, so **sync died permanently on a phone whose app was
already current**, with the line telling her to update it. No race and no
second device: it fired for every user on the next bump, and it silently
removed the only thing keeping her library alive anywhere but one phone.

A baseline this build cannot compare against is now simply one it does not
have — which is what the thing has always claimed to be, and the next accepted
push writes a fresh one at the current version. The cost is one round-trip of
degraded precision (the row above), never a Phrase.

**Only the version is judged.** An empty baseline at the current version is
still a baseline, and it means the opposite thing — see *Empty, not absent*
below.

Rejected: migrating the baseline through `normalizeLibrary` on read, which is
more precise and buys a round-trip of `updatedAt`-only exposure back. It also
puts her records through a second, unwitnessed migration path whose failure
mode is a baseline that wrongly reads as agreed — and that direction *can*
delete. Dropping can only degrade. Also rejected: clearing the baseline in the
IDB upgrade, which fixes the version skew and none of the other reasons a
stored baseline can be unusable.

## The pinned voice (T067)

The envelope carries one field that is not a Deck, a Mix or a Tombstone: the
**pinned voice**. It is a preference, and losing it on a new phone was
expensive — the decks arrived, the drill was blocked on `no-voice`, and she
had no way to know which voice she had before.

Three rules, and they are all short:

- **It is joined on by name, never exported wholesale.** `DeckStore.exportAll()`
  still reads only `decks`, `mixes` and `tombstones`;
  `adapters/sync/synced-library.ts` adds `voice` and nothing else. What leaves
  this device is enumerated, so a field added to the `settings` store later
  stays on the phone until somebody names it too.
- **Last writer wins, with no timestamp.** `mergeLibraries` takes
  `local.voice ?? remote.voice`: this device's, unless this device has none.
  No `pinnedAt` was invented, because since T067 there is nothing left for one
  to protect — a Clip is playable in the voice it was made in, so losing this
  conflict changes what the next NEW Phrase is generated in and nothing else.
  Before T067 the same rule would have been reckless: it could have re-pinned
  her voice and regenerated the whole library.
- **Absent means "none recorded", never "clear it".** An envelope written
  before T067 has no `voice` field at all; it leaves the local pin alone. That
  also makes the field safe against an older build, which strips it on push:
  the next sync from any device that has one puts it back, and the worst case
  in between is the status quo before this feature existed. That is why this
  is an optional additive field and **not** a `schemaVersion` bump — a bump
  would 409 her other phone out of syncing her *phrases* until it updated, to
  protect a field that heals itself.

The same field travels in a backup FILE, and restore treats it the same way:
`parseLibraryFile` accepts a file with it and a file without it, and a
restore pins the file's voice if it has one and leaves the local pin alone if
it does not.

## A restore outranks a deletion the server still holds (T072)

Restore from a file used to undo itself. `importAll` clears this device's
Tombstones; the server keeps its own; the next round-trip pulls them back and
re-deletes exactly the Deck she just restored. She sees the restore work, and
seconds later watches it vanish — against handwritten phrases that exist
nowhere else.

It bites in the two cases she actually meets:

| Situation | Why the Tombstone won |
| --------- | --------------------- |
| A new phone, restored from Files | No baseline at all, so nothing can be shown to have been written since — the Tombstone wins on its clock alone |
| A phone that has not yet picked up the other device's deletion | The baseline still holds the Deck, and a restored Deck is byte-identical to it, so it reads as *unchanged since the agreement* |

The fix uses the record the merge already trusts over any clock. A Tombstone
deletes only a record unchanged from the last state both sides agreed on
(T070) — and **every record a restore wrote was written by the restore**, after
any agreement, whatever its `updatedAt` says. So a restore sets the baseline to
an **empty library**: `syncEngine.libraryRestored(applyLibrary)`, which empties
the baseline *before* it applies the local write, so a baseline that could not
be recorded stops the restore instead of letting it apply on top of an intact
one.

### Both writes, or neither (T081)

The two writes were originally the caller's to sequence —
`libraryRestored().then(() => writeLocal(library))` — and they came apart in
both directions.

**A round-trip already in flight.** The last thing a successful round-trip does
is write the library it pushed into the baseline, and that library was computed
before the restore. It landed on top of the empty baseline, so the next merge
read every restored Deck as unchanged since the last agreement and let the
server's Tombstone delete it — on the phone and on the server. The T072 defect
verbatim, through a race T072 never closed: its own tests all called
`libraryRestored()` with the engine idle, and the engine is not idle when she
taps Restore.

The engine now counts restores. A round-trip reads the count once at the start
and compares it before the merge and again before the baseline write; a
round-trip that finds it moved writes nothing, claims no sync time, and ends at
`waiting` with a retry scheduled — its push may well have been accepted, but
what is on the phone now is the restored library and that has not been
anywhere.

**A local write that failed.** The emptied baseline over an unchanged library
is the same defect pointing the other way: every Tombstone she ever wrote reads
as written since the agreement, so the next merge resurrects every Deck she has
ever deleted, here and on the server. `libraryRestored` therefore takes the
local write, and puts the previous baseline back if it refuses.

Where there is nothing to put back — a device that has never synced — the empty
baseline stays. Empty and absent are not equally safe here: absent lets a
Tombstone delete on its clock alone, empty resurrects a deletion. Only one of
those can lose a Phrase.

Rejected: writing the library first and the baseline second, which makes the
common failure the T072 defect rather than a resurrection. Rejected: stopping
the engine for the duration of a restore, which leaves an unstarted engine
behind on any path that throws.

**Empty, not absent.** They are different answers and only one is right: absent
means "there is no baseline to reason from", which is the first row of the
table above. Empty means "we agreed on nothing", under which every local record
reads as written since, outranks the Tombstone, and — because a Tombstone whose
record survives is dropped — takes the deletion off the server too. It resolves
once instead of flapping.

**No new persisted field and no schema bump.** The baseline is derived,
per-device bookkeeping in the `settings` store that is never sent anywhere, so
nothing about the `Library` envelope changes and no existing database needs
migrating. The price is one degraded round-trip: with an empty baseline a Deck
both sides hold keeps the later name and the **union** of its Phrases, which
cannot lose a Phrase.

Rejected: re-dating the restored records (`updatedAt = now`), which overwrites
timestamps that are hers and still loses to a phone whose clock is ahead; and a
"restoredAt" field on the envelope, which is a persisted-state change to protect
against a case the baseline already answers.

## What she sees

One line on the Decks screen (`src/ui/sync-status-text.ts`). The time is
relative — "3 minutes ago" answers "is my phone up to date?" without her
knowing what time it is now, and carries no timezone to get wrong.

| State          | Line                                                                    |
| -------------- | ------------------------------------------------------------------------ |
| `idle`         | `Synced 3 minutes ago` / `Not synced yet`                                |
| `syncing`      | `Syncing…`                                                               |
| `waiting`      | `Saved on this phone · will sync when back online · last synced 2 hours ago` |
| `signed-out`   | `Saved on this phone · sign in again to sync`                            |
| `needs-update` | `Saved on this phone · update the app to sync`                           |

Every state that is not a completed sync opens with **"Saved on this phone"**.
That is the sentence that answers the fear, and it comes before anything about
what went wrong.

`signed-out` (a 401) and `needs-update` (a 409 `stale-client`, or an envelope
written by a newer build than this one) are the two failures a retry cannot
fix, so the engine stops retrying and says what only she can do about it. A
local change made in either state does not paint over the message.

## Nothing in the round-trip may throw (T069)

`run()` used to be `try`/`finally` with no `catch`, and four of the calls
`roundTrip` awaits raise their failures by throwing rather than returning
them. One of those — a `QuotaExceededError` from the local write, or a
`response.json()` on a truncated body — rejected `run()` into a promise
nobody read, and the engine stopped at `syncing` with no retry scheduled and
no way back. The line said **"Syncing…"** for the rest of the session while
nothing left the phone, which is exactly the condition the Backup age
indicator exists to expose, defeated.

So `roundTrip` now **returns** every failure, including the thrown ones, and
each maps onto a state the engine already had:

| Throws | Reported as | Ends in |
| ------ | ----------- | ------- |
| `client.pull()` / `client.push()` | `network` | `waiting`, retry scheduled |
| `baseline.read()` | `device-storage` | `waiting`, retry scheduled |
| `updateLocal()` — its read or its write | `device-storage` | `waiting`, retry scheduled — **and the push is skipped**, so a merge this device could not save is never made the agreed state |
| `baseline.write()`, `recordSync()` | `device-storage` | `waiting`, retry scheduled, and no sync time claimed |

One failure is not a throw at all: a restore landing mid-round-trip reports
`superseded`, which ends the same way — `waiting`, retry scheduled, nothing
written and no sync time claimed (T081, above).

`device-storage` is the storage counterpart of `network`: a condition that
passes, so it waits and tries again. It is deliberately **not** `unreadable`
— an app update does not create disk space, and mapping it to `needs-update`
would stop sync for good over a full origin.

`run()` also has a `catch` of its own. Reaching it is a fault in the engine
rather than in the device, but the one outcome that must be impossible is an
engine that stops without scheduling anything, because that failure is silent
and permanent. `emit` swallows a subscriber's exception for the same reason: a
screen that fails to render must not be able to stop the thing that is getting
her phrases off this phone.

**A corrupt server row** is handled where it happens:
`library-sync-client.ts` reads `response.json()` inside its `try` and reports
`network`. Retryable on purpose — a truncated transfer is far likelier than a
permanently unreadable `libraries.data` row, and a build that declares itself
stale cannot repair either one. The local library is untouched: a pull that
fails means no push, per rule 1 above.

The residual gap: a row that really is permanently corrupt leaves the line
reading `Saved on this phone · will sync when back online` forever, which is
true about her phrases and misleading about the cause. The Backup age
indicator is what surfaces it, and repairing the row is a server-side job.

## Known gaps

- **Two devices editing the *same Phrase* between round-trips.** The later
  Deck's text wins and the other rendering is dropped. See above for why there
  is nowhere to put the loser.
- **Mixes are still whole-record.** A Mix conflict loses one side's Deck
  selection — a list of ids she can re-make in seconds, not text she wrote. The
  same applies to a Mix she edits while a merge is landing: `persistMix` writes
  a whole Mix from React state, which T075 stopped doing for Decks and did not
  for Mixes (see above for why).
- **A Phrase deleted on the other device comes back here** until this device
  deletes it too (T070). The fix is a Phrase-level deletion record, which is a
  change to the persisted `Library` envelope and to every write path — not a
  merge change.
- **A Phrase deleted on the other device between a restore and the next sync
  comes back**, like any other Phrase deletion the other side records (row
  above). An empty baseline widens that to Decks and Mixes on the first
  round-trip after a restore: a deletion made elsewhere that this phone had not
  yet seen is undone, and she has to delete it again — one tap. The trade is
  deliberate; the other direction is her restore being undone.
- **No conflict is surfaced to her.** The merge is silent because every
  outcome it can produce keeps her phrases; the one lossy case above is not
  reported. Reporting it would need a place to show it and a decision for her
  to make, which is the opposite of this feature's premise.
