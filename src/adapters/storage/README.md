# adapters/storage

Wraps IndexedDB (via `idb`) for persisting drill data in the browser.

Boundary: the only place `idb` or `indexedDB` is imported. Exposes a small port
the domain can call; never leaks `idb` types outward. Persisted data formats are
migrated, never silently changed.

## The versioning rule

Changing the shape of `DeckRecord`/`PhraseRecord`/`MixRecord`
(`domain/ports.ts` — what actually gets written to IndexedDB and to the
export file) requires, in the same change:

1. bump `CURRENT_SCHEMA_VERSION` in `migrations.ts`
2. register the migration step at the matching index in `DECK_MIGRATIONS`
3. update the pinned shape in `persisted-shape.test.ts` (`npm test -- -u`)

Skip any of these and existing decks on the user's device read back wrong
with no error. `persisted-shape.test.ts` enforces all three: it fails
`npm run build` on an added/removed/renamed field (the fixture is typed
against the real interfaces) and fails `npm test` if `DECK_MIGRATIONS` ever
falls out of sync with `CURRENT_SCHEMA_VERSION`.

## The stores

One database (`phrase-drill`), one version number, seven stores — all declared
in the single `openDatabase()` upgrade path (`database.ts`):

| Store | Holds | Added |
|---|---|---|
| `decks` | Deck records (Phrases inside them) | v1 |
| `settings` | pinned voice, nudge/sync flags | v1 |
| `clips` | content-addressed audio cache — derived, never exported | v2 |
| `errors` | diagnostics ring buffer | v3 |
| `mixes` | saved Mixes — Deck **ids**, never Phrases | v4 (T059) |
| `tombstones` | what was deleted, and when — so sync can merge | v5 (T060) |
| `clipMeta` | size index over `clips` — `{ hash, bytes, lastUsedAt }` | v6 (T036) |

## The clip cache is bounded, and eviction cannot reach a Phrase

`clips` grew forever until T036: ~890 MB at a 10,000-Phrase library
(`docs/scale.md` §1), with nothing that ever shrank it. On iOS storage
pressure is itself an eviction trigger, so an origin that fat is one Safari
may discard **whole** — taking the Decks and Phrases with it. The audio cache
was on course to destroy the library it exists to serve.

`clip-cache.ts` now holds a ceiling (`DEFAULT_CLIP_CACHE_MAX_BYTES`, 200 MB)
and evicts **least recently played** down to 90% of it whenever a `put`
crosses the line. Two things make that safe rather than merely intended:

- **`get()` is what counts as playing; `has()` is not.** `has` is the
  readiness sweep's question, asked of every Phrase at every drill start — if
  it counted as use, one sweep would reset every Clip's age at once and there
  would be nothing left to order by.
- **Eviction can name exactly two stores.** `delete` is only ever called with
  `CLIPS_STORE` and `CLIP_META_STORE`. It is not a rule someone has to
  remember: `clip-cache-eviction.test.ts` runs a 20,000-Clip cold fill and
  asserts, against a log of every destructive IndexedDB operation the fake
  received, that no other store was touched — and that the Decks, Phrases and
  Mixes are byte-identical afterwards.

`clipMeta` is a separate store rather than fields on the Clip because the
whole point is that reading it is cheap: `getAll(CLIPS_STORE)` deserializes
every `ArrayBuffer` off disk (`docs/scale.md` §3), which at a full cache is
hundreds of MB to answer a question about numbers. `readyPhraseIds` and
`has` now read the index too, which removes that whole-cache load from every
drill start.

`decks` and `mixes` are separate stores on purpose: it makes "deleting a Mix
never touches its source Decks" — and its converse — structural rather than a
rule someone has to remember. The one place they meet is the `Library`
envelope (`exportAll`/`importAll`/`updateAll`, `/api/library`), which carries
both, because a backup or a new phone that restored only half of her data
would be worse than one that restored none.

`updateAll` is the sync path's write and the reason the envelope has three
verbs rather than two (T074): it reads the stores, applies a merge, and writes
the result in **one transaction**, so a Deck she saved while a round-trip was
in flight cannot be computed away by a snapshot taken before she typed it. See
`docs/sync.md`.

`update` is the same rule for a single Deck, and it is the composition root's
write (T075). `save` puts a whole Deck computed somewhere else — from React
state, which is a view and is stale by the time a tap reaches storage — so it
is now reserved for a Deck that does not exist yet, where there is nothing
under that id to overwrite. Changing one that does exist reads it and puts the
result in one transaction, with the change applied to what is stored at that
instant. The defect it closes did not stop at this device: the Phrase it
overwrote was still in the Sync Baseline, which the merge reads as a deletion
and takes to the server (`docs/sync.md`).

`tombstones` is the exception to that separation, and deliberately so: both
the deck store and the mix store write to it, each only its own `kind`, and
neither ever reads the other's rows. It exists because sync **merges** two
devices' libraries rather than overwriting one with the other (T060 —
`domain/library-merge.ts` holds the rule), and a merge cannot tell "she
deleted this" from "this device has never seen it" unless the deletion is
itself recorded. Removing a Deck or a Mix writes its Tombstone in the *same*
transaction as the delete: a delete without one is a delete every other
device undoes at the next sync.
