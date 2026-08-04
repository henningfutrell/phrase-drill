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

One database (`phrase-drill`), one version number, five stores — all declared
in the single `openDatabase()` upgrade path (`database.ts`):

| Store | Holds | Added |
|---|---|---|
| `decks` | Deck records (Phrases inside them) | v1 |
| `settings` | pinned voice, nudge/sync flags | v1 |
| `clips` | content-addressed audio cache — derived, never exported | v2 |
| `errors` | diagnostics ring buffer | v3 |
| `mixes` | saved Mixes — Deck **ids**, never Phrases | v4 (T059) |

`decks` and `mixes` are separate stores on purpose: it makes "deleting a Mix
never touches its source Decks" — and its converse — structural rather than a
rule someone has to remember. The one place they meet is the `Library`
envelope (`exportAll`/`importAll`, `/api/library`), which carries both,
because a backup or a new phone that restored only half of her data would be
worse than one that restored none.
