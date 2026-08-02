/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
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
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
      },
      manifest: {
        id: '/',
        name: 'phrase-drill',
        short_name: 'phrase-drill',
        description:
          'Drill saved French phrases on your phone, including offline.',
        start_url: '/',
        scope: '/',
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
        theme_color: '#101114',
        background_color: '#101114',
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
  },
})
