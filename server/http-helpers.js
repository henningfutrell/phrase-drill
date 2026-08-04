/** Thrown by `readBody` when a request body exceeds its configured cap. */
export class PayloadTooLargeError extends Error {}

/**
 * Reads a request body into a `Buffer`, giving up the moment it exceeds
 * `maxBytes` rather than buffering an attacker-controlled amount of memory
 * first — this is the "cap request sizes" obligation (T041): a Scan is an
 * image upload, and an unbounded one is a free denial-of-wallet (it still
 * reaches this server's memory/CPU even if never forwarded upstream). On
 * overflow it stops accumulating chunks and drains the rest of the request
 * (`resume()`) without storing it, so the connection can still be used to
 * write a normal 413 response instead of being reset out from under the
 * client mid-upload.
 */
export function readBody(req, { maxBytes }) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    let settled = false

    function fail(err) {
      if (settled) return
      settled = true
      req.removeAllListeners('data')
      req.removeAllListeners('end')
      req.resume()
      reject(err)
    }

    req.on('data', (chunk) => {
      if (settled) return
      total += chunk.length
      if (total > maxBytes) {
        fail(new PayloadTooLargeError(`body exceeded ${maxBytes} bytes`))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks))
    })
    req.on('error', fail)
  })
}

export function sendJson(res, status, body, headers = {}) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    ...headers,
  })
  res.end(text)
}
