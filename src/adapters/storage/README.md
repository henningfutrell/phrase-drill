# adapters/storage

Wraps IndexedDB (via `idb`) for persisting drill data in the browser.

Boundary: the only place `idb` or `indexedDB` is imported. Exposes a small port
the domain can call; never leaks `idb` types outward. Persisted data formats are
migrated, never silently changed.

## The versioning rule

Changing the shape of `DeckRecord`/`PhraseRecord` (`domain/ports.ts` — what
actually gets written to IndexedDB and to the export file) requires, in the
same change:

1. bump `CURRENT_SCHEMA_VERSION` in `migrations.ts`
2. register the migration step at the matching index in `DECK_MIGRATIONS`
3. update the pinned shape in `persisted-shape.test.ts` (`npm test -- -u`)

Skip any of these and existing decks on the user's device read back wrong
with no error. `persisted-shape.test.ts` enforces all three: it fails
`npm run build` on an added/removed/renamed field (the fixture is typed
against the real interfaces) and fails `npm test` if `DECK_MIGRATIONS` ever
falls out of sync with `CURRENT_SCHEMA_VERSION`.
