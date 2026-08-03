# Sync — the `/api/library/:key` wire contract

What `worker/` (T033) provides: one origin serving the built PWA and a
durable, server-side copy of a Library, addressed by a device-generated
Library Key. The client half — auto-sync, when to call this, conflict
resolution UI — is T034. This document is the contract the client is built
against.

## Identity: the Library Key

No accounts, no passwords, no email, no PII. A device generates a
high-entropy random string (this repo's own generator is T034's concern; the
server only validates the *shape*: 16–128 characters, `[A-Za-z0-9_-]`) and
uses it as the path segment for every request. That string *is* the
credential — see "Threat model" below.

A second person using this app is a second Library Key, generated on their
own device. Nothing server-side distinguishes "people" — there is no user
table, only Library Keys, each addressing one stored object.

## Routes

### `GET /api/library/:key`

| Response | Meaning |
| --- | --- |
| `200`, body = the stored `Library` JSON, header `ETag: "<etag>"` | The current server-side copy. |
| `404`, `{"error":"not-found"}` | Nothing has ever been stored under this key — an empty/never-synced Library, not an error. The client's first sync is a `PUT` with `If-None-Match: *` (see below); there is nothing to restore. |
| `400`, `{"error":"invalid-key"}` | The path segment isn't a plausible Library Key (wrong length/charset). |

### `PUT /api/library/:key`

Body: the `Library` JSON exactly as produced by `exportAll()`
(`src/adapters/storage/library.ts` / `src/domain/ports.ts`) —
`{ format, schemaVersion, exportedAt, decks }`. The server does not parse
`decks`/`phrases` at all; it only checks the envelope (see "Validation").

**A precondition header is required on every `PUT`** — there is no
unconditional write, so a stale client can never silently clobber a newer
server copy:

| Header | Means | Server does |
| --- | --- | --- |
| `If-None-Match: *` | "I believe nothing is stored yet; create only." | Stores only if the key has no existing object. |
| `If-Match: "<etag>"` | "I last fetched (or last successfully wrote) this etag; store only if the server still has exactly that version." | Stores only if the current stored object's etag still matches. |
| *(neither)* | — | `400`, `{"error":"missing-precondition"}`. Refused outright: no precondition means "overwrite whatever's there," which is exactly the silent-destruction case this contract exists to prevent. |

This is deliberately plain HTTP conditional-request semantics (RFC 9110
`If-Match`/`If-None-Match`), not a hand-rolled generation counter: R2's
`put(..., { onlyIf })` implements the compare-and-swap atomically inside the
storage layer itself. A counter the Worker maintained itself would need its
own read-modify-write around the `put`, with no transaction spanning the
two — reintroducing the exact race this precondition exists to close.

| Response | Meaning |
| --- | --- |
| `200`, `{"ok":true,"etag":"<new etag>"}`, header `ETag` | Stored. This is now the current version. |
| `409`, `{"error":"conflict","reason":"stale","current":<Library>}`, header `ETag` of `current` | `If-Match` didn't match what's on the server. The write was **refused, not merged, not applied** — `current` is the server's actual copy, handed back so the caller doesn't need a second `GET` to see what it lost the race against. Conflict *resolution* (what to do about it) is T034's. |
| `409`, `{"error":"conflict","reason":"missing"}` | `If-Match` was sent but there is no stored object to match against. |
| `409`, `{"error":"conflict",...}` (via `If-None-Match: *`) | Create-only write refused because an object already exists. Same `current`/`reason` shape as above. |
| `400`, `{"error":"malformed-body","detail":"not-json"\|"invalid"}` | Body isn't JSON, or is JSON but not an object / missing `schemaVersion` or `decks`. |
| `400`, `{"error":"wrong-format"}` | `format` isn't `"phrase-drill-library"`. |
| `400`, `{"error":"schema-version-too-new","serverSchemaVersion":<n>}` | `schemaVersion` is newer than this deployment understands (`CURRENT_SCHEMA_VERSION`, `src/adapters/storage/migrations.ts`). Refused rather than stored blind — a future client's shape the server has never seen must never silently become "the" server copy that an older client then reads and misinterprets. |
| `413`, `{"error":"payload-too-large","maxBytes":8388608}` | Body exceeds the 8 MiB app-level cap (`worker/contract.ts` `MAX_LIBRARY_BYTES`) — far above a real multi-thousand-phrase export, well under R2's own per-object ceiling. Nothing is stored. |
| `400`, `{"error":"invalid-key"}` | As `GET`. |

### Anything else

`405` with an `Allow` header on any other method to `/api/library/:key`;
`404` on any other path *if* the request ever reaches the Worker at all — in
production, `assets.run_worker_first` (`wrangler.jsonc`) means only
`/api/*` requests reach `worker/index.ts` in the first place; every other
path is served directly from `dist/`.

## Empty / never-synced library

There is no special "empty library" representation. A device that has never
synced simply gets `404` from `GET`. Its first `PUT` uses
`If-None-Match: *` — a plain create. There is nothing to migrate or
initialize server-side; the R2 object springs into existence on the first
successful write.

## Validation the server does and does not do

- **Does**: envelope shape (`format`, `schemaVersion` is a number and not
  from the future, `decks` is an array, valid JSON, size cap, Library Key
  shape).
- **Does not**: understand a `Phrase`, a `Deck`, or any field inside
  `decks`. The server stores and returns exactly the bytes it was given
  (once the envelope passes); `src/domain/` and its schema stay the single
  source of that shape, per AGENTS.md.

## Threat model — what a Library Key grants

The Library Key is a bearer credential, not a login. **Anyone who obtains
one can `GET` (read every phrase in that Library) and `PUT` (overwrite or
destroy it, once they've done one `GET` to learn the current `ETag`)** —
full read/write control of that one Library, nothing more. It grants no
access to any other Library, to R2 outside the one key's object, or to any
Cloudflare account resource. It carries no name, email, or other PII beyond
the French/English phrases themselves. Losing a key is exactly as bad as
losing a Library-specific bearer token, because that's what it is: treat it
like a password (don't post it, don't put it in a URL you screenshot and
share), but there is no recovery flow — a leaked/lost key is a new key and a
fresh sync from whichever device still has the data.
