import { execFileSync } from 'node:child_process'
import { defineConfig } from 'vite'
import { configDefaults } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

/**
 * The build stamp Diagnostics (T039) shows so a remote bug report can be
 * pinned to a deploy — she reads the sha aloud rather than guessing whether
 * she has today's build. Computed once here (build or dev-server start) via
 * `define`, so it's a compile-time constant `src/vite-env.d.ts` declares as
 * `__BUILD_SHA__`/`__BUILD_TIME__` — available under `npm test` too, since
 * Vitest shares this config file. Falls back to `'unknown'` rather than
 * failing the build if `.git` is unavailable (e.g. a source archive).
 */
function readBuildSha(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}
const buildSha = readBuildSha()
const buildTime = new Date().toISOString()

// https://vite.dev/config/
// T041: this build now ships to two different roots — GitHub Pages under
// https://henningfutrell.github.io/phrase-drill/ (scripts/deploy.sh) and the
// Docker/Coolify server (server/static.js) at a domain root. The app has no
// URL-based routing (App.tsx switches screens by React state, never the
// path), so a relative base resolves correctly under either: asset and
// manifest URLs are written relative to index.html's own location, which is
// the sub-path on Pages and the root in the container.
const base = './'

export default defineConfig({
  base,
  define: {
    __BUILD_SHA__: JSON.stringify(buildSha),
    __BUILD_TIME__: JSON.stringify(buildTime),
  },
  plugins: [
    react(),
    VitePWA({
      // autoUpdate + skipWaiting/clientsClaim: the owner is non-technical
      // and has no hard-refresh reflex, so a new deploy must take over the
      // open tab on its own rather than waiting for her to close every tab
      // (the default "prompt" strategy would leave her stuck on stale
      // code with no way out). See docs/pwa.md.
      registerType: 'autoUpdate',
      includeAssets: ['icons/apple-touch-icon-180.png'],
      workbox: {
        clientsClaim: true,
        skipWaiting: true,
        // woff2 is in this list deliberately (T058). The app's two faces are
        // self-hosted, and an offline drill that falls back to Palatino is a
        // different app. This is also why only the `latin` subsets are
        // vendored: precache takes everything matched here up front, so
        // unicode-range never gets the chance to skip a subset she cannot
        // render a character from. See src/styles/fonts.css.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest,woff2}'],
      },
      manifest: {
        id: base,
        name: 'phrase-drill',
        short_name: 'phrase-drill',
        description:
          'Drill saved French phrases on your phone, including offline.',
        start_url: base,
        scope: base,
        display: 'standalone',
        orientation: 'portrait',
        // Design palette (docs/design.md): both fields use `--bg`, not
        // `--accent`. `background_color` is the splash-screen ground, so it
        // is literally the app's background token. `theme_color` tints the
        // OS/browser chrome (status bar, task switcher) — the design reserves
        // `--accent` for exactly three UI states (live beat, primary action,
        // current selection) and is explicit that it "never decorates";
        // tinting chrome with it would be a fourth, undesigned use, so chrome
        // gets `--bg` too and stays dark and neutral like the rest of the app.
        theme_color: '#191016',
        background_color: '#191016',
        icons: [
          {
            src: 'icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'icons/icon-512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
    }),
  ],
  test: {
    environment: 'jsdom',
    // Stryker's sandbox (T043) is a full copy of the repo with the source
    // deliberately mutated. Without this, `npm test` collects both copies —
    // the suite silently doubles and half of it is asserting against code
    // that was broken on purpose. A failed or interrupted mutation run
    // leaves the directory behind, so the exclusion cannot be conditional.
    exclude: [...configDefaults.exclude, '.stryker-tmp/**'],
  },
})
