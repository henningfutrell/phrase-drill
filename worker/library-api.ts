/**
 * The `/api/library/:key` route handlers. See docs/sync.md for the wire
 * contract these implement. R2 is the only I/O here — everything about what
 * counts as a valid envelope lives in `./contract.ts` and is tested without
 * a bucket at all.
 */
import { jsonResponse } from './responses'
import { MAX_LIBRARY_BYTES, parseLibraryEnvelope, type LibraryEnvelopeError } from './contract'

export async function getLibrary(bucket: R2Bucket, key: string): Promise<Response> {
  const object = await bucket.get(key)
  if (!object) {
    // Never synced from any device yet — not an error, the honest state of
    // a library that has only ever lived on one phone so far.
    return jsonResponse(404, { error: 'not-found' })
  }

  const body = await object.text()
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json', etag: object.httpEtag },
  })
}

export async function putLibrary(request: Request, bucket: R2Bucket, key: string): Promise<Response> {
  const ifMatch = request.headers.get('if-match')
  const ifNoneMatch = request.headers.get('if-none-match')
  if (!ifMatch && !ifNoneMatch) {
    // No precondition at all means "I don't know what's on the server and
    // I'm willing to destroy it" — refused outright, never silently allowed.
    return jsonResponse(400, {
      error: 'missing-precondition',
      detail: 'PUT requires If-Match (update) or If-None-Match: * (create)',
    })
  }

  const contentLength = request.headers.get('content-length')
  if (contentLength && Number(contentLength) > MAX_LIBRARY_BYTES) {
    return jsonResponse(413, { error: 'payload-too-large', maxBytes: MAX_LIBRARY_BYTES })
  }

  const raw = await request.text()
  if (new TextEncoder().encode(raw).byteLength > MAX_LIBRARY_BYTES) {
    return jsonResponse(413, { error: 'payload-too-large', maxBytes: MAX_LIBRARY_BYTES })
  }

  const envelope = parseLibraryEnvelope(raw)
  if (!envelope.ok) {
    return envelopeErrorResponse(envelope.error)
  }

  const onlyIf = new Headers()
  if (ifMatch) onlyIf.set('if-match', ifMatch)
  if (ifNoneMatch) onlyIf.set('if-none-match', ifNoneMatch)

  const putResult = await bucket.put(key, raw, {
    onlyIf,
    httpMetadata: { contentType: 'application/json' },
  })

  if (putResult === null) {
    // The precondition didn't hold: someone else's write (or a stale local
    // copy) got there first. Never silently accepted — and the caller gets
    // the server's actual current copy back so it doesn't need a second
    // round trip to see what it lost the race against.
    return conflictResponse(bucket, key)
  }

  return jsonResponse(200, { ok: true, etag: putResult.httpEtag }, { etag: putResult.httpEtag })
}

async function conflictResponse(bucket: R2Bucket, key: string): Promise<Response> {
  const current = await bucket.get(key)
  if (!current) {
    // If-Match was sent but there is nothing on the server to match —
    // distinct from a stale write: there is no "current" to hand back.
    return jsonResponse(409, { error: 'conflict', reason: 'missing' })
  }
  const currentBody = await current.text()
  return new Response(
    JSON.stringify({ error: 'conflict', reason: 'stale', current: JSON.parse(currentBody) }),
    { status: 409, headers: { 'content-type': 'application/json', etag: current.httpEtag } },
  )
}

function envelopeErrorResponse(error: LibraryEnvelopeError): Response {
  switch (error.kind) {
    case 'not-json':
    case 'invalid':
      return jsonResponse(400, { error: 'malformed-body', detail: error.kind })
    case 'wrong-format':
      return jsonResponse(400, { error: 'wrong-format' })
    case 'schema-version-too-new':
      return jsonResponse(400, {
        error: 'schema-version-too-new',
        serverSchemaVersion: error.serverSchemaVersion,
      })
  }
}
