# src

`App.tsx` and `main.tsx` are the composition root: they wire adapters into the
domain and render screens. They may import from `domain/` and `adapters/*`.
Nothing under `domain/` or `adapters/*` may import from here.

- `domain/` — pure domain core, no I/O. See `domain/README.md`.
- `adapters/speech/` — Web Speech API. See its README.
- `adapters/storage/` — IndexedDB. See its README.
- `adapters/vision/` — Claude vision API. See its README.
