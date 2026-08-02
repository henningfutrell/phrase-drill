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
    // Both fields must be the design's `--bg` token (docs/design.md), not an
    // invented colour — this is the assertion that keeps the manifest from
    // silently drifting from the settled palette again.
    expect(manifest.theme_color).toBe('#101114')
    expect(manifest.background_color).toBe('#101114')

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
})
