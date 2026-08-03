import type { DraftPhrase, ScanError, ScanReader } from '../../domain'
import { type PreparedImage, prepareImageForUpload } from './image-prep'

export interface ServerScanReaderDeps {
  /** Reads the device's library key from wherever it is stored (T041 — never a provider key). */
  getLibraryKey(): Promise<string>
  /** Re-encodes and downscales the photo before upload. Defaults to the canvas-based encoder. */
  prepareImage?: (image: Blob) => Promise<PreparedImage>
  /** Injected in tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
}

/**
 * The `ScanReader` implementation for T041: talks to this app's own
 * `/api/scan`, same-origin, authenticated with the device's library key —
 * never an Anthropic key, which the device no longer holds. Replaces
 * `claude-scan-reader.ts`; the domain-level `ScanReader`/`ScanError`/
 * `DraftPhrase` types are untouched (they were always domain ports, not this
 * adapter's own). The image is still downsized/re-encoded on-device first
 * (`image-prep.ts`, unchanged) so the upload this server has to size-cap
 * stays small before it ever leaves the phone.
 */
export function createServerScanReader(deps: ServerScanReaderDeps): ScanReader {
  const prepareImage = deps.prepareImage ?? prepareImageForUpload
  const fetchImpl = deps.fetchImpl ?? fetch

  return {
    async read(image, signal) {
      const libraryKey = await deps.getLibraryKey()

      let prepared: PreparedImage
      try {
        prepared = await prepareImage(image)
      } catch (err) {
        return Promise.reject(unreadable(`could not prepare image: ${describe(err)}`))
      }

      const bytes = base64ToBytes(prepared.base64)

      let response: Response
      try {
        response = await fetchImpl('/api/scan', {
          method: 'POST',
          signal,
          headers: {
            'content-type': prepared.mediaType,
            authorization: `Bearer ${libraryKey}`,
          },
          body: new Blob([bytes], { type: prepared.mediaType }),
        })
      } catch (err) {
        return Promise.reject(networkError(describe(err)))
      }

      if (response.status === 401 || response.status === 503) {
        return Promise.reject(unauthorized())
      }

      if (response.status === 422) {
        return Promise.reject(unreadable('server could not read the scan'))
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

      return parseDraftPhrases(body)
    },
  }
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function parseDraftPhrases(body: unknown): DraftPhrase[] {
  const phrases = isRecord(body) ? body.phrases : undefined
  if (!Array.isArray(phrases)) {
    throw unreadable('response did not contain a phrases array')
  }

  return phrases.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.french !== 'string' || typeof entry.english !== 'string') {
      throw unreadable(`phrase at index ${index} was not a valid french/english pair`)
    }
    return { french: entry.french, english: entry.english }
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function unauthorized(): ScanError {
  return { kind: 'unauthorized' }
}

function unreadable(detail: string): ScanError {
  return { kind: 'unreadable', detail }
}

function networkError(detail: string): ScanError {
  return { kind: 'network', detail }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
