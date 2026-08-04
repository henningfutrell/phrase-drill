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
2. **Merge**, never replace: `mergeLibraries(local, remote, baseline)`.
3. **Write the merge back locally, before pushing.** If the push then fails,
   what came down from the other device is already saved here.
4. **Push the merge.** It is a superset of what the server held, so a push can
   add records and never remove one.
5. **Only then** record the baseline and the sync time.

`lastSyncAt` is written by step 5 and by nothing else, so a failure can never
report a time and the sync line can never say "Synced" about a round-trip that
did not complete.

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

**With no baseline** (the first sync ever, or after IndexedDB eviction) a Deck
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
them. One of those — a `QuotaExceededError` from `writeLocal`, or a
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
| `readLocal()`, `baseline.read()` | `device-storage` | `waiting`, retry scheduled |
| `writeLocal()` | `device-storage` | `waiting`, retry scheduled — **and the push is skipped**, so a merge this device could not save is never made the agreed state |
| `baseline.write()`, `recordSync()` | `device-storage` | `waiting`, retry scheduled, and no sync time claimed |

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
  selection — a list of ids she can re-make in seconds, not text she wrote.
- **A Phrase deleted on the other device comes back here** until this device
  deletes it too (T070). The fix is a Phrase-level deletion record, which is a
  change to the persisted `Library` envelope and to every write path — not a
  merge change.
- **No conflict is surfaced to her.** The merge is silent because every
  outcome it can produce keeps her phrases; the one lossy case above is not
  reported. Reporting it would need a place to show it and a decision for her
  to make, which is the opposite of this feature's premise.
