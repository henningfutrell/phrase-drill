import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

// Verifies the production build is installable and usable offline on iOS:
// a web app manifest with the fields iOS/Android read, a service worker that
// precaches the shell, and the apple-* head tags iOS Safari needs (it does
// not read the manifest for these). Runs the real `npm run build` and
// inspects its output, since none of this has meaning outside a real build.

const rootDir = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.join(rootDir, 'dist')

/**
 * Reads one custom property out of `src/styles/tokens.css` — the single place
 * the palette is declared — so build output can be asserted against the token
 * itself instead of a transcription of it. Throws rather than returning a
 * default: a token that has been renamed must fail loudly here, not quietly
 * compare against `undefined`.
 */
function readToken(name: string): string {
  const css = readFileSync(path.join(rootDir, 'src', 'styles', 'tokens.css'), 'utf-8')
  const match = new RegExp(`^\\s*${name}:\\s*([^;]+);`, 'm').exec(css)
  if (!match) throw new Error(`${name} is not declared in src/styles/tokens.css`)
  return match[1].trim()
}

describe('PWA build output', () => {
  beforeAll(() => {
    // Force a real production build regardless of the test runner's own
    // NODE_ENV, so this doesn't silently ride on vitest's dev-mode React.
    execFileSync('npm', ['run', 'build'], {
      cwd: rootDir,
      stdio: 'inherit',
      env: { ...process.env, NODE_ENV: 'production' },
    })
  }, 120_000)

  it('emits a web app manifest with the fields an iOS/Android home-screen install needs', () => {
    const manifestPath = path.join(distDir, 'manifest.webmanifest')
    expect(existsSync(manifestPath)).toBe(true)

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      name?: string
      short_name?: string
      display?: string
      start_url?: string
      orientation?: string
      theme_color?: string
      background_color?: string
      icons?: Array<{ sizes?: string; purpose?: string }>
    }

    expect(manifest.name).toBe('phrase-drill')
    expect(manifest.short_name).toBeTruthy()
    expect(manifest.display).toBe('standalone')
    expect(manifest.orientation).toBe('portrait')
    expect(manifest.start_url).toBeTruthy()
    // Both fields must be the design's `--bg` token, not an invented colour —
    // this is the assertion that keeps the manifest from silently drifting
    // from the settled palette.
    //
    // Read from tokens.css rather than written here as a literal (T058). The
    // hard-coded version did catch the redesign, which is the point of it, but
    // it caught it as a failing test somebody has to hand-edit — and a check
    // whose green state depends on remembering to update a copy of the value
    // is a check that eventually gets updated without being thought about.
    // Deriving it pins the relationship (manifest === --bg) instead of the
    // colour, so the next palette change needs no edit here at all.
    const bg = readToken('--bg')
    expect(bg).toMatch(/^#[0-9a-f]{6}$/)
    expect(manifest.theme_color).toBe(bg)
    expect(manifest.background_color).toBe(bg)

    const sizes = (manifest.icons ?? []).map((icon) => icon.sizes)
    expect(sizes).toContain('192x192')
    expect(sizes).toContain('512x512')
    expect(
      (manifest.icons ?? []).some((icon) => icon.purpose?.includes('maskable')),
    ).toBe(true)
  })

  it('emits a service worker that precaches the app shell', () => {
    expect(existsSync(path.join(distDir, 'sw.js'))).toBe(true)
    const sw = readFileSync(path.join(distDir, 'sw.js'), 'utf-8')
    // generateSW-produced workers embed a precache manifest naming the built
    // shell entry points; assert on the mechanism, not exact filenames.
    expect(sw).toMatch(/precache/i)
    expect(sw).toContain('index.html')
  })

  it('built index.html carries the apple-* tags iOS Safari needs for home-screen install', () => {
    const html = readFileSync(path.join(distDir, 'index.html'), 'utf-8')
    expect(html).toContain('rel="apple-touch-icon"')
    expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"')
    expect(html).toContain('name="apple-mobile-web-app-status-bar-style"')
    expect(html).toContain('name="apple-mobile-web-app-title"')
    expect(html).toContain('rel="manifest"')
  })

  // T041: this build now ships to two different roots — GitHub Pages under
  // /phrase-drill/ (scripts/deploy.sh) and the Docker/Coolify server
  // (server/static.js) at a domain root. The app has no URL-based routing
  // (App.tsx switches screens by React state, never the path), so
  // vite.config.ts uses a relative base ('./'): every emitted path resolves
  // relative to wherever index.html itself is served from, correct under
  // either root without a second build.
  it('scopes the manifest identity relative to index.html, not to a fixed root', () => {
    const manifestPath = path.join(distDir, 'manifest.webmanifest')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      id?: string
      start_url?: string
      scope?: string
    }

    expect(manifest.id).toBe('./')
    expect(manifest.start_url).toBe('./')
    expect(manifest.scope).toBe('./')
  })

  it('emits every asset and icon href relative to index.html, not under a fixed root', () => {
    const html = readFileSync(path.join(distDir, 'index.html'), 'utf-8')

    const scriptSrc = html.match(/<script type="module"[^>]*src="([^"]+)"/)?.[1]
    const stylesheetHref = html.match(/<link rel="stylesheet"[^>]*href="([^"]+)"/)?.[1]
    const manifestHref = html.match(/<link rel="manifest" href="([^"]+)"/)?.[1]
    const faviconHref = html.match(/<link rel="icon"[^>]*href="([^"]+)"/)?.[1]
    const appleTouchIconHref = html.match(
      /<link rel="apple-touch-icon"[^>]*href="([^"]+)"/,
    )?.[1]

    expect(scriptSrc).toMatch(/^\.\/assets\//)
    expect(stylesheetHref).toMatch(/^\.\/assets\//)
    expect(manifestHref).toBe('./manifest.webmanifest')
    expect(faviconHref).toBe('./favicon.svg')
    expect(appleTouchIconHref).toBe('./icons/apple-touch-icon-180.png')
  })
})
