import { describe, expect, it, vi } from 'vitest'
import { createServerTranslator } from './server-translator'

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response
}

function makeTranslator(overrides: { fetchImpl?: typeof fetch; getAccessToken?: () => Promise<string> } = {}) {
  const fetchImpl = overrides.fetchImpl ?? vi.fn()
  const getAccessToken = overrides.getAccessToken ?? vi.fn().mockResolvedValue('token-123')
  const translator = createServerTranslator({ getAccessToken, fetchImpl })
  return { translator, fetchImpl, getAccessToken }
}

describe('createServerTranslator', () => {
  it('posts text, direction, and deckName to /api/translate with a bearer token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { candidates: [{ text: 'Bonjour' }] }))
    const { translator } = makeTranslator({ fetchImpl })

    await translator.translate('Hello', 'en-to-fr', 'home')

    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('/api/translate')
    expect(init.method).toBe('POST')
    expect(init.headers.authorization).toBe('Bearer token-123')
    expect(JSON.parse(init.body)).toEqual({ text: 'Hello', direction: 'en-to-fr', deckName: 'home' })
  })

  it('resolves to the parsed candidates, register included when present', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        candidates: [
          { text: 'Tu peux venir?', register: 'tu' },
          { text: 'Pouvez-vous venir?', register: 'vous' },
        ],
      }),
    )
    const { translator } = makeTranslator({ fetchImpl })
    const result = await translator.translate('Can you come?', 'en-to-fr', 'friends')
    expect(result).toEqual([
      { text: 'Tu peux venir?', register: 'tu' },
      { text: 'Pouvez-vous venir?', register: 'vous' },
    ])
  })

  it('drops an absent register rather than carrying an empty string', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { candidates: [{ text: 'Bonjour', register: '' }] }))
    const { translator } = makeTranslator({ fetchImpl })
    const result = await translator.translate('Hello', 'en-to-fr', 'home')
    expect(result).toEqual([{ text: 'Bonjour' }])
  })

  it('resolves to an empty array when nothing could genuinely be proposed', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { candidates: [] }))
    const { translator } = makeTranslator({ fetchImpl })
    await expect(translator.translate('', 'en-to-fr', 'home')).resolves.toEqual([])
  })

  it('rejects unauthorized on 401', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(401, { error: 'unauthorized' }))
    const { translator } = makeTranslator({ fetchImpl })
    await expect(translator.translate('Hello', 'en-to-fr', 'home')).rejects.toMatchObject({ kind: 'unauthorized' })
  })

  it('rejects unauthorized on 503 (key not configured — same treatment as an expired token)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(503, { error: 'not-configured' }))
    const { translator } = makeTranslator({ fetchImpl })
    await expect(translator.translate('Hello', 'en-to-fr', 'home')).rejects.toMatchObject({ kind: 'unauthorized' })
  })

  it('rejects unreadable on 422', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(422, { error: 'unreadable' }))
    const { translator } = makeTranslator({ fetchImpl })
    await expect(translator.translate('Hello', 'en-to-fr', 'home')).rejects.toMatchObject({ kind: 'unreadable' })
  })

  it('rejects network on other non-ok statuses and on a rejected fetch', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(500, { error: 'server-error' }))
    const { translator } = makeTranslator({ fetchImpl })
    await expect(translator.translate('Hello', 'en-to-fr', 'home')).rejects.toMatchObject({ kind: 'network' })

    const throwingFetch = vi.fn().mockRejectedValue(new Error('offline'))
    const { translator: translator2 } = makeTranslator({ fetchImpl: throwingFetch })
    await expect(translator2.translate('Hello', 'en-to-fr', 'home')).rejects.toMatchObject({ kind: 'network' })
  })

  it('rejects unreadable when the response body is not valid JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => {
        throw new Error('not json')
      },
    } as unknown as Response)
    const { translator } = makeTranslator({ fetchImpl })
    await expect(translator.translate('Hello', 'en-to-fr', 'home')).rejects.toMatchObject({ kind: 'unreadable' })
  })

  it('supports the reverse direction (fr-to-en)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { candidates: [{ text: 'Hello' }] }))
    const { translator } = makeTranslator({ fetchImpl })
    await translator.translate('Bonjour', 'fr-to-en', 'home')
    const [, init] = fetchImpl.mock.calls[0]
    expect(JSON.parse(init.body).direction).toBe('fr-to-en')
  })
})
