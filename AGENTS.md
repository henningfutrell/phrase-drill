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
  (audio element unlock and reuse, IndexedDB quirks, PWA install/offline
  behavior), not Chrome's.
- **One Worker, one origin.** A Cloudflare Worker (`worker/`) serves the
  built PWA (`dist/`, as static assets) and a small sync API
  (`/api/library/:key`, `docs/sync.md`) from the same origin — no CORS, no
  second host. Identity is a device-generated Library Key, never an
  account: no email, no password, no PII beyond the phrases themselves.
  IndexedDB (via `idb`) is still the on-device store and the thing the app
  reads/writes during normal use; the Worker's R2 bucket is the durable
  server-side copy that survives an iOS eviction or a new phone, which
  IndexedDB alone cannot. Outbound network calls the *browser* makes
  directly (never proxied by the Worker): the Claude vision API for
  handwriting import, and the ElevenLabs text-to-speech API for Clip
  generation. The Worker never sees either API key.

## Architecture: ports and adapters

```
src/
  domain/            pure domain core
  adapters/audio/     ClipPlayer (SpeechPort over cached Clips) + ElevenLabs synth client
  adapters/storage/   IndexedDB (via idb) — decks, settings, the clip cache
  adapters/vision/     Claude vision API (handwriting import)
  App.tsx, main.tsx    composition root: wires adapters into domain, renders screens
worker/               the Cloudflare Worker — a new seam, outside src/domain/
                       and outside every src/adapters/ directory (docs/sync.md).
                       It never imports from src/adapters/* (idb, the vision or
                       ElevenLabs clients are browser-only) or from React/DOM.
                       It does reuse the plain-data Library shape and
                       schemaVersion from src/domain and
                       src/adapters/storage/migrations.ts — both dependency-free
                       — rather than inventing a second serialization.
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
the user's saved phrases is not recoverable. The same rule covers the
server-side copy in R2 (`worker/`, `docs/sync.md`): it stores the same
`Library`/`schemaVersion` shape, so a migration that covers IndexedDB covers
it too — there is no second format to keep in step by hand.

This is also why the app now serves from a Worker's origin root rather than
GitHub Pages' `/phrase-drill/` sub-path (`vite.config.ts`): IndexedDB is
scoped per-origin, so moving hosts orphans every saved Library on every
phone. This move happened now, before any release, because no user data
exists anywhere yet — it is not to be repeated once that stops being true.

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
