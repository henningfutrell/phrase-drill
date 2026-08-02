# adapters/storage

Wraps IndexedDB (via `idb`) for persisting drill data in the browser.

Boundary: the only place `idb` or `indexedDB` is imported. Exposes a small port
the domain can call; never leaks `idb` types outward. Persisted data formats are
migrated, never silently changed.
