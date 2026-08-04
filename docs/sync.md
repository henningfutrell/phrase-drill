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
- **Three-way per Phrase** (T034), when a **Sync Baseline** exists.

The baseline is the last snapshot this device and the server agreed on. With
it, "these two Decks differ" splits into the three answers that matter:

| Case                        | Result                                                                 |
| --------------------------- | ------------------------------------------------------------------------ |
| Only one side changed       | That side wins whole, deletions included.                                |
| Both changed                | Merge per Phrase by id: additions from both sides are kept; a deletion applies only to a Phrase the other side left exactly as the baseline had it — **an edit outranks a delete**. |
| The same Phrase edited on both | The later Deck's text wins (a tie keeps local).                       |

**That last row is the only place a keystroke can still be lost**, and it is
deliberate: a `Phrase` has one French field and one English field, and
inventing a second copy of a phrase would corrupt the drill she is running.
Everything else — different Phrases of the same Deck, an add against a delete,
a rename against an edit — is preserved on both sides.

**With no baseline** (the first sync ever, or after IndexedDB eviction) every
Deck falls back to whole-record last-write-wins, exactly as T060 behaved. A
missing baseline degrades the merge; it never breaks it.

The baseline is per-device, never sent anywhere, and lives in the `settings`
object store under the `syncBaseline` key
(`src/adapters/storage/sync-baseline-store.ts`) — a key rather than an object
store of its own, because a new store is a schema version bump and a migration
for every existing database, and this is derived data whose loss costs one
round-trip's precision.

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

## Known gaps

- **Two devices editing the *same Phrase* between round-trips.** The later
  Deck's text wins and the other rendering is dropped. See above for why there
  is nowhere to put the loser.
- **Mixes are still whole-record.** A Mix conflict loses one side's Deck
  selection — a list of ids she can re-make in seconds, not text she wrote.
- **No conflict is surfaced to her.** The merge is silent because every
  outcome it can produce keeps her phrases; the one lossy case above is not
  reported. Reporting it would need a place to show it and a decision for her
  to make, which is the opposite of this feature's premise.
