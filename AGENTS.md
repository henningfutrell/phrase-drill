# AGENTS.md — phrase-drill

Any agent working in this repo states, before making changes: "I have read
phrase-drill/AGENTS.md."

## What this is

A French phrase-drill tool built for one person: a single non-technical user who
practises French phrases on their iPhone. There is no second user, no admin
surface, no multi-tenant anything. Every design choice optimizes for that one
user's phone, not for hypothetical others.

## Hard constraints

- **iOS Safari only.** The only browser that has to work is Safari on iPhone.
  Do not add cross-browser workarounds, polyfills, or feature detection for
  engines nobody here uses. Test assumptions against Safari's behavior
  (Web Speech API voice availability, IndexedDB quirks, PWA install/offline
  behavior), not Chrome's.
- **No server.** This is a static PWA: HTML/CSS/JS built once and served as
  files. All state lives in the browser (IndexedDB via `idb`). Outbound
  network calls: the Claude vision API for handwriting import, and the
  ElevenLabs text-to-speech API for Clip generation. Nothing here runs a
  backend, a database, or an API route of its own. `npm run build` output
  must be static files, deployable to any static host.

## Architecture: ports and adapters

```
src/
  domain/            pure domain core
  adapters/audio/     ClipPlayer (SpeechPort over cached Clips) + ElevenLabs synth client
  adapters/storage/   IndexedDB (via idb) — decks, settings, the clip cache
  adapters/vision/     Claude vision API (handwriting import)
  App.tsx, main.tsx    composition root: wires adapters into domain, renders screens
```

- `domain/` imports nothing from `adapters/*`, `react`, `idb`, the DOM, or any
  browser/network API. It has no I/O. Every external dependency is a parameter
  or an injected port. This is what makes the domain testable without a
  browser and rewritable if any single adapter changes.
- Each `adapters/*` directory owns exactly one external seam (speech
  synthesis, storage, or the vision API) and is the only place that imports
  the corresponding browser API or SDK. It exposes a small port; it never
  leaks its own types (e.g. `idb`'s types, `SpeechSynthesisUtterance`) outward
  into the domain or the UI.
- `App.tsx`/`main.tsx` are the only files allowed to import from both
  `domain/` and `adapters/*` — that is what a composition root is for.

If a change needs the domain to know about IndexedDB, Web Speech, or an HTTP
call, that change belongs in an adapter, not the domain.

## Persisted state

Drill data (phrases, progress) lives in IndexedDB — it is the user's, not the
code's. A schema/format change to what's stored migrates existing data or is
not made. Breaking a contract elsewhere costs an afternoon; silently dropping
the user's saved phrases is not recoverable.

## Testing

Test-first. Write the failing test before the implementation, for domain logic
and adapters alike. `npm test` must exit 0 before a change lands. The domain,
having no I/O, is tested directly with plain unit tests; adapters are tested
against fakes/mocks of the browser API they wrap.

## Glossary

`docs/glossary.md` is the single source of the domain's terms. Code, tests,
events, and UI use those terms and no others. If a concept needs a name that
isn't in the glossary, the glossary gets updated in the same change — not
after.

## Git

Use `/usr/bin/git` explicitly for every git operation in this repo, never a
bare `git`.
