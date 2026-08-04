import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Asserts the shared unlock `<audio>` element (T006) is markup in
 * `index.html`, not something `App.tsx`/`main.tsx` constructs at runtime.
 * Same "read the real build artifact" style as `pwa.build.test.ts` next to
 * this file — a `src/` test cannot see `index.html` (no Node types there;
 * see `tsconfig.app.json`), so this lives at the project root instead.
 *
 * The regression this guards against: `new Audio()` built and given a `src`
 * inside the same tap that plays it is Apple's documented iOS Safari
 * anti-pattern — the load has not started when `play()` is called, which can
 * miss the gesture window entirely. An element already attached to the
 * document, with no initial `src`, avoids it. A unit test on `clip-player.ts`
 * cannot see this — `AudioElementLike` is satisfied by a fake there either
 * way — so this checks the one place the real wiring actually lives.
 */
describe('index.html — the shared unlock <audio> element (T006)', () => {
  const rootDir = path.dirname(fileURLToPath(import.meta.url))
  const html = readFileSync(path.join(rootDir, 'index.html'), 'utf-8')
  // Anchored on the `id`, not just any `<audio` — the doc comment above the
  // real tag also says the word "<audio>" in prose, and a naive first-match
  // regex would silently pass against that instead of the actual element.
  const tag = html.match(/<audio\b[^>]*\bid="unlock-audio"[^>]*>/)

  it('is present in the document markup, not constructed at runtime', () => {
    expect(tag).not.toBeNull()
  })

  it('carries no initial src — the whole point', () => {
    expect(tag![0]).not.toMatch(/\bsrc=/)
  })

  it('is marked preload="auto" and playsinline, per Apple’s own guidance', () => {
    expect(tag![0]).toMatch(/\bpreload="auto"/)
    expect(tag![0]).toMatch(/\bplaysinline\b/)
  })
})
