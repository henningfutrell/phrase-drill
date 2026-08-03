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
- **The server holds the keys, she never touches one (T041).** `server/`
  is a plain-Node HTTP server — no framework, no vendor SDK — that owns both
  provider credentials (`ELEVENLABS_API_KEY`, `ANTHROPIC_API_KEY`, env only)
  and her phrase library (Postgres, T043). The device never sees a provider
  key: it authenticates to the server with a Keycloak-issued access token
  (browser login, authorization code + PKCE — T043, replacing the earlier
  device-generated library key entirely) and calls same-origin `/api/tts`,
  `/api/scan`, `/api/library`. Three services (`docker-compose.yml`) —
  the app, Postgres, Keycloak — serve the stack together; see
  `docs/server.md` for endpoints, env vars, local run, and Coolify deploy.
  The offline drill is unaffected — the server generates Clips, the device
  still caches and plays them from cache with no mid-run network dependency.

## Architecture: ports and adapters

```
src/
  domain/            pure domain core
  adapters/audio/     ClipPlayer (SpeechPort over cached Clips) + server synth client
  adapters/storage/   IndexedDB (via idb) — decks, settings, the clip cache
  adapters/vision/     server scan-reader client (handwriting import)
  adapters/sync/       library sync client (push/pull against /api/library)
  App.tsx, main.tsx    composition root: wires adapters into domain, renders screens
server/
  index.js, app.js, db.js, providers/, ...   the HTTP server (docs/server.md)
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

**Changing `src/domain/` also means running `npm run test:mutation`** (~15s).
It breaks the domain on purpose and checks the tests notice — a surviving
mutant is a located statement that some behaviour is not pinned by anything.
The threshold is a ratchet: raise it as survivors are killed, never lower it.
`docs/testing.md` covers scope, how to read a survivor, and the known baseline.

## Glossary

`docs/glossary.md` is the single source of the domain's terms. Code, tests,
events, and UI use those terms and no others. If a concept needs a name that
isn't in the glossary, the glossary gets updated in the same change — not
after.

## Git

Use `/usr/bin/git` explicitly for every git operation in this repo, never a
bare `git`.
