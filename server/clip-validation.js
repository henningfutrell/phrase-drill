/**
 * Whether a synthesized body is fit to be cached, before `clipStore.put`
 * (F6 audit, defect 2; audio audit 2026-10-03).
 *
 * `put` is `ON CONFLICT (hash) DO NOTHING` (`server/db.js`), so the first
 * bytes ever stored under a hash are served to every device forever, and no
 * purge path exists. A 200 that is HTTP-well-formed but not a whole MP3 — a
 * JSON or HTML error page over 1 KB, a mid-stream cut, a proxy's body —
 * would otherwise become that permanent clip. Three independent checks, each
 * catching what the others cannot:
 *
 * - **content-type** `audio/mpeg`, which we asked for (`accept`) and the
 *   pinned `mp3_44100_128` format is. Absent counts as wrong: a provider
 *   that stops saying what it sent is a provider whose bytes are unverified.
 * - **framing**: an `ID3` tag, or an MP3 frame sync (0xFF then the top three
 *   bits of the next byte set). Catches a correct header over a wrong body.
 * - **size band**, per character of text. The floor is the old flat 1,000
 *   bytes (~62 ms at 16 bytes/ms — far short of any phrase worth asking
 *   for), raised to 100 bytes/char (~6 ms of speech per character, well below
 *   the fastest speech); the ceiling is 6,400 bytes/char (400 ms/char, slower
 *   than any speech) plus 48,000 for tags and padding. Deliberately loose: a
 *   false rejection costs one phrase to regenerate, a missed truncation costs
 *   a permanently botched clip on every device — the costs are not symmetric,
 *   so the band errs toward under-rejecting.
 *
 * Pure: returns `null` when fit, else the reason, for the caller to log and
 * wrap as `unreadable`. The reason never includes the text.
 */
export function validateClip({ bytes, contentType, text }) {
  if (!contentType || !contentType.toLowerCase().startsWith('audio/mpeg')) {
    return `content-type is ${contentType ? `"${contentType}"` : 'missing'}, not audio/mpeg`
  }
  if (!looksLikeMp3(bytes)) return 'body does not start with an ID3 tag or an MP3 frame sync'

  const min = Math.max(1000, text.length * 100)
  const max = text.length * 6400 + 48_000
  if (bytes.byteLength < min) return `implausibly short body (${bytes.byteLength} bytes, minimum ${min}) for this text`
  if (bytes.byteLength > max) return `implausibly long body (${bytes.byteLength} bytes, maximum ${max}) for this text`
  return null
}

function looksLikeMp3(bytes) {
  if (bytes.byteLength >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return true // 'ID3'
  return bytes.byteLength >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0
}
