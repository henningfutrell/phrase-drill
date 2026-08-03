/**
 * The pure envelope rules for the sync wire contract (docs/sync.md). Kept
 * free of `Request`/`Response`/R2 — same reason `src/domain/` stays free of
 * `idb`: these rules are what a unit test should check directly, not only
 * through a live HTTP round trip.
 *
 * Deliberately reuses `LIBRARY_FORMAT` and `CURRENT_SCHEMA_VERSION` from the
 * existing storage adapter rather than inventing a second serialization —
 * the server doesn't parse phrase content, but it must still recognise the
 * one format tag and refuse a schema version it doesn't know about yet.
 */
import { LIBRARY_FORMAT } from '../src/domain'
import { CURRENT_SCHEMA_VERSION } from '../src/adapters/storage/migrations'

export { CURRENT_SCHEMA_VERSION }

/** A device-generated library key: high-entropy, URL-path-safe, no PII. */
const KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/

export function isValidLibraryKey(key: string): boolean {
  return KEY_PATTERN.test(key)
}

/** App-level cap, well above a multi-thousand-phrase export (docs/sync.md). */
export const MAX_LIBRARY_BYTES = 8 * 1024 * 1024

export type LibraryEnvelopeError =
  | { kind: 'not-json' }
  | { kind: 'invalid' }
  | { kind: 'wrong-format' }
  | { kind: 'schema-version-too-new'; serverSchemaVersion: number }

export type LibraryEnvelopeResult =
  | { ok: true; parsed: { format: string; schemaVersion: number; decks: unknown[] } }
  | { ok: false; error: LibraryEnvelopeError }

/**
 * Validate the envelope of a stored/incoming library body: valid JSON, an
 * object, the right `format` tag, and a `schemaVersion` this server knows
 * about (never a silent accept of a version from the future — the whole
 * point being that decks/phrases inside stay opaque to the server either
 * way).
 */
export function parseLibraryEnvelope(raw: string): LibraryEnvelopeResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, error: { kind: 'not-json' } }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: { kind: 'invalid' } }
  }

  const candidate = parsed as Record<string, unknown>
  if (candidate.format !== LIBRARY_FORMAT) {
    return { ok: false, error: { kind: 'wrong-format' } }
  }
  if (typeof candidate.schemaVersion !== 'number' || !Array.isArray(candidate.decks)) {
    return { ok: false, error: { kind: 'invalid' } }
  }
  if (candidate.schemaVersion > CURRENT_SCHEMA_VERSION) {
    return {
      ok: false,
      error: { kind: 'schema-version-too-new', serverSchemaVersion: CURRENT_SCHEMA_VERSION },
    }
  }

  return {
    ok: true,
    parsed: candidate as { format: string; schemaVersion: number; decks: unknown[] },
  }
}
