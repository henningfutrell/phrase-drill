// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { createPasswordPolicy, PWNED_RANGE_URL } from './password-policy.js'

const CLEAN = 'correct horse 42 battery'
const sha1 = (s) => createHash('sha1').update(s, 'utf8').digest('hex').toUpperCase()
const prefixOf = (s) => sha1(s).slice(0, 5)
const suffixOf = (s) => sha1(s).slice(5)

/** A fake HIBP range API answering `lines` (`SUFFIX:COUNT`), recording each request. */
function fakeRange(lines, { status = 200 } = {}) {
  const impl = async (url, init) => {
    impl.requests.push({ url: String(url), init })
    return { ok: status >= 200 && status < 300, status, text: async () => lines.join('\r\n') }
  }
  impl.requests = []
  return impl
}

/** Some other suffixes, so a match has to be found among neighbours. */
const NEIGHBOURS = ['0018A45C4D1DEF81644B54AB7F969B88D65:1', '00D4F6E8FA6EECAD2A3AA415EEC418D38EC:2']

describe('password policy', () => {
  it('accepts a clean password that meets the rules', async () => {
    const fetchImpl = fakeRange(NEIGHBOURS)
    expect(await createPasswordPolicy({ fetchImpl })(CLEAN)).toEqual({ ok: true })
  })

  it('rejects a password HIBP has seen, as breached', async () => {
    const fetchImpl = fakeRange([...NEIGHBOURS, `${suffixOf(CLEAN)}:3730471`])
    expect(await createPasswordPolicy({ fetchImpl })(CLEAN)).toEqual({ ok: false, reason: 'breached' })
  })

  it('matches the suffix whatever its case in the answer', async () => {
    const fetchImpl = fakeRange([`${suffixOf(CLEAN).toLowerCase()}:2`])
    expect(await createPasswordPolicy({ fetchImpl })(CLEAN)).toEqual({ ok: false, reason: 'breached' })
  })

  it('ignores a padding entry (count 0) for the same suffix', async () => {
    const fetchImpl = fakeRange([...NEIGHBOURS, `${suffixOf(CLEAN)}:0`])
    expect(await createPasswordPolicy({ fetchImpl })(CLEAN)).toEqual({ ok: true })
  })

  it('sends only the 5-character prefix, with Add-Padding, and never the password or full hash', async () => {
    const fetchImpl = fakeRange(NEIGHBOURS)
    await createPasswordPolicy({ fetchImpl })(CLEAN)
    expect(fetchImpl.requests).toHaveLength(1)
    const [{ url, init }] = fetchImpl.requests
    expect(url).toBe(`${PWNED_RANGE_URL}${prefixOf(CLEAN)}`)
    expect(new Headers(init.headers).get('add-padding')).toBe('true')
    const sent = JSON.stringify({ url, init })
    expect(sent).not.toContain(CLEAN)
    expect(sent.toUpperCase()).not.toContain(sha1(CLEAN))
    expect(sent.toUpperCase()).not.toContain(suffixOf(CLEAN))
  })

  it('fails closed when HIBP cannot be reached', async () => {
    const fetchImpl = async () => {
      throw new TypeError('fetch failed')
    }
    expect(await createPasswordPolicy({ fetchImpl })(CLEAN)).toEqual({ ok: false, reason: 'unverified' })
  })

  it('fails closed on a non-2xx answer', async () => {
    const fetchImpl = fakeRange([], { status: 503 })
    expect(await createPasswordPolicy({ fetchImpl })(CLEAN)).toEqual({ ok: false, reason: 'unverified' })
  })

  it('fails closed when HIBP does not answer in time', async () => {
    const fetchImpl = (_url, init) =>
      new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)))
    expect(await createPasswordPolicy({ fetchImpl, timeoutMs: 10 })(CLEAN)).toEqual({ ok: false, reason: 'unverified' })
  })

  it('fails closed when the answer body cannot be read', async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      text: async () => {
        throw new Error('premature close')
      },
    })
    expect(await createPasswordPolicy({ fetchImpl })(CLEAN)).toEqual({ ok: false, reason: 'unverified' })
  })

  it.each([
    ['too-short', 'abcdefgh123'],
    ['no-digit', 'abcdefghijklmn'],
    ['no-letter', '12345678901234'],
    ['empty', ''],
  ])('rejects a password that breaks the rules (%s) without asking HIBP', async (_name, password) => {
    const fetchImpl = fakeRange(NEIGHBOURS)
    const result = await createPasswordPolicy({ fetchImpl })(password)
    expect(result.ok).toBe(false)
    expect(fetchImpl.requests).toHaveLength(0)
  })

  it('names the rule each password breaks', async () => {
    const check = createPasswordPolicy({ fetchImpl: fakeRange(NEIGHBOURS) })
    expect(await check('abcdefgh123')).toEqual({ ok: false, reason: 'too-short' })
    expect(await check('abcdefghijklmn')).toEqual({ ok: false, reason: 'no-digit' })
    expect(await check('12345678901234')).toEqual({ ok: false, reason: 'no-letter' })
  })

  it('accepts exactly 12 characters', async () => {
    expect(await createPasswordPolicy({ fetchImpl: fakeRange(NEIGHBOURS) })('abcdefghij12')).toEqual({ ok: true })
  })

  it('refuses a value that is not a string', async () => {
    const fetchImpl = fakeRange(NEIGHBOURS)
    expect(await createPasswordPolicy({ fetchImpl })(undefined)).toEqual({ ok: false, reason: 'too-short' })
    expect(fetchImpl.requests).toHaveLength(0)
  })
})
