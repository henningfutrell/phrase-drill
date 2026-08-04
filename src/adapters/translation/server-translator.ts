import type { PhraseCandidate, TranslateDirection, TranslateError, Translator } from '../../domain'

export interface ServerTranslatorDeps {
  /** Reads the current session token from wherever it is stored (T050 — never a provider key). */
  getAccessToken(): Promise<string>
  /** Injected in tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
}

/**
 * The `Translator` implementation for T057: talks to this app's own
 * `/api/translate`, same-origin, authenticated with a session token (T050) —
 * never an Anthropic key, which the device never holds. Modeled on
 * `../vision/server-scan-reader.ts`: the domain-level `Translator`/
 * `TranslateError`/`PhraseCandidate` types are untouched, they were always
 * domain ports, not this adapter's own.
 */
export function createServerTranslator(deps: ServerTranslatorDeps): Translator {
  const fetchImpl = deps.fetchImpl ?? fetch

  return {
    async translate(text: string, direction: TranslateDirection, deckName: string, signal?: AbortSignal) {
      const accessToken = await deps.getAccessToken()

      let response: Response
      try {
        response = await fetchImpl('/api/translate', {
          method: 'POST',
          signal,
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ text, direction, deckName }),
        })
      } catch (err) {
        return Promise.reject(networkError(describe(err)))
      }

      if (response.status === 401 || response.status === 503) {
        return Promise.reject(unauthorized())
      }

      if (response.status === 422) {
        return Promise.reject(unreadable('server could not propose a translation'))
      }

      if (!response.ok) {
        return Promise.reject(networkError(`server responded ${response.status}`))
      }

      let body: unknown
      try {
        body = await response.json()
      } catch (err) {
        return Promise.reject(unreadable(`response was not valid JSON: ${describe(err)}`))
      }

      return parseCandidates(body)
    },
  }
}

function parseCandidates(body: unknown): PhraseCandidate[] {
  const candidates = isRecord(body) ? body.candidates : undefined
  if (!Array.isArray(candidates)) {
    throw unreadable('response did not contain a candidates array')
  }

  return candidates.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.text !== 'string' || entry.text.trim().length === 0) {
      throw unreadable(`candidate at index ${index} was not a valid text entry`)
    }
    const register = typeof entry.register === 'string' && entry.register.trim().length > 0 ? entry.register : undefined
    return register ? { text: entry.text, register } : { text: entry.text }
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function unauthorized(): TranslateError {
  return { kind: 'unauthorized' }
}

function unreadable(detail: string): TranslateError {
  return { kind: 'unreadable', detail }
}

function networkError(detail: string): TranslateError {
  return { kind: 'network', detail }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
