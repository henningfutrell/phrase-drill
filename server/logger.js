/**
 * Structured stdout logging (T041 "logs go to stdout and are readable"),
 * one JSON line per event. `secrets` are the two provider API keys, read
 * once at startup from the environment — every string field passed to
 * `log` is redacted against them before it is stringified, so a key can
 * never ride along in a log line even if some deeper layer's error message
 * happened to include it.
 */
export function createLogger({ secrets = [], write = defaultWrite } = {}) {
  const knownSecrets = secrets.filter((s) => typeof s === 'string' && s.length > 0)

  function redact(value) {
    if (typeof value !== 'string') return value
    let out = value
    for (const secret of knownSecrets) {
      out = out.split(secret).join('[REDACTED]')
    }
    return out
  }

  function log(level, msg, fields = {}) {
    const safeFields = {}
    for (const [key, value] of Object.entries(fields)) {
      safeFields[key] = redact(value)
    }
    write(JSON.stringify({ level, ts: new Date().toISOString(), msg: redact(msg), ...safeFields }))
  }

  return {
    info: (msg, fields) => log('info', msg, fields),
    warn: (msg, fields) => log('warn', msg, fields),
    error: (msg, fields) => log('error', msg, fields),
  }
}

function defaultWrite(line) {
  process.stdout.write(line + '\n')
}
