# PWA: install and offline

`phrase-drill` is a static build (`npm run build`) installed to the iPhone
home screen. This records what's configured, the iOS-specific gotchas, how
to test an install, and — most importantly — the iOS storage limitation the
owner should know about.

## What's configured

[`vite-plugin-pwa`](https://vite-pwa-org.netlify.app/) with the Workbox
`generateSW` strategy (`vite.config.ts`). It emits, into `dist/` at build
time:

- `manifest.webmanifest` — `name`/`short_name` "phrase-drill", `display:
  standalone`, `orientation: portrait`, `start_url`/`scope: /`, theme colour
  and background colour both `#101114` (the design's `--bg` token, see
  `docs/design.md`), and an icon set (`192`, `512`, `512` maskable).
- `sw.js` + `workbox-*.js` — a generated service worker that precaches the
  app shell (JS/CSS/HTML/icons/manifest) so the app opens with no network.
- `registerSW.js`, auto-injected into `index.html` — registers the service
  worker on load.

**Update strategy: `registerType: 'autoUpdate'` with `skipWaiting: true` and
`clientsClaim: true`.** The owner is not technical and has no hard-refresh
reflex — if a stale service worker kept serving an old build, she'd have no
way out and no one to ask. `autoUpdate` checks for a new service worker on
every load and activates it immediately (`skipWaiting`) and takes control of
the open page without waiting for a reload (`clientsClaim`), instead of the
plugin's default `prompt` strategy, which would need a UI she'd have to
understand and act on. The trade-off, accepted deliberately: a deploy can
swap code out from under an open tab. For a single-user drill app with no
multi-tab collaboration to protect, that's the right side of the trade.

### iOS-specific head tags (`index.html`)

iOS Safari does not read the manifest for install metadata — this is the
part most PWA setups get wrong. It needs its own tags, added directly to
`index.html` since `vite-plugin-pwa` does not inject them:

```html
<link rel="apple-touch-icon" href="/icons/apple-touch-icon-180.png" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="default" />
<meta name="apple-mobile-web-app-title" content="phrase-drill" />
```

Without `apple-mobile-web-app-capable`, "Add to Home Screen" still works but
launches into a Safari-chrome tab instead of a standalone window. Without
`apple-touch-icon`, iOS falls back to a screenshot of the page as the icon.

### Icons

`public/icons/icon-source.svg` is a plain geometric placeholder (purple
field, a white speech-bubble mark) — deliberately simple, since a real
design is a separate, later task. All content sits inside the centered 80%
"safe zone" so the same source works unmodified as both a regular and a
maskable icon (maskable icons get cropped to a shape by the OS; content
outside the safe zone gets clipped). Rasterised with `rsvg-convert` (already
on the machine — no network fetch, no new dependency) to:

| File | Size | Used for |
| --- | --- | --- |
| `apple-touch-icon-180.png` | 180×180 | iOS home-screen icon |
| `icon-192.png` | 192×192 | manifest, `purpose: any` |
| `icon-512.png` | 512×512 | manifest, `purpose: any` |
| `icon-512-maskable.png` | 512×512 | manifest, `purpose: maskable` |

## Testing an install on an iPhone

1. `npm run build && npm run preview -- --host` (serves `dist/` on the LAN).
2. On the iPhone, open the printed LAN URL in Safari (must be Safari — "Add
   to Home Screen" for a PWA is Safari-only on iOS; Chrome/Firefox on iOS
   are WebKit wrappers without the same install affordance).
3. Share button → **Add to Home Screen**. Confirm the app name and the
   purple speech-bubble icon look right on the confirmation screen.
4. Launch from the home screen icon, not the Safari tab. Confirm it opens
   full-screen with no Safari address bar (`display: standalone` +
   `apple-mobile-web-app-capable` both need to be right for this).
5. Turn on Airplane Mode, kill the app, relaunch from the home screen icon.
   The shell must still load — that's the precache working.
6. To test the update path: change something, rebuild, redeploy, relaunch
   the app from the home screen — it should pick up the change without
   needing to be deleted and reinstalled.

## iOS limitations the owner should know about

**This is the most important thing in this document.** iOS evicts a Safari
tab's `IndexedDB`/`localStorage` data after roughly seven days of no
interaction with that site, under Intelligent Tracking Prevention (ITP).
That would mean her saved phrase library could silently disappear from a
browser tab she hasn't opened in a while. **WebKit's own tracking-prevention
documentation states that a home-screen web app's origin is exempt from this
7-day cap** ([webkit.org/tracking-prevention](https://webkit.org/tracking-prevention/)).
Installing to the home screen is therefore not just a convenience here — **it
is the first line of defence for her data.** She should always open the app
from its home-screen icon, never re-add it from a fresh Safari search each
time.

Belt-and-braces beyond installation (`navigator.storage.persist()`,
requesting the browser's separate "don't evict this origin under storage
pressure" guarantee) is explicitly **not** implemented here — that call
belongs with the storage/IndexedDB task, to avoid two pieces of code
racing to own the same API. This document exists so whoever picks that up
knows why it matters.

Other iOS-specific behaviour worth knowing, most to least important:

- **The home-screen app and the Safari tab do not share storage.** Since
  iOS 14, they share `CacheStorage` and the service worker registration
  (so assets aren't downloaded twice), but cookies, `localStorage`, and
  `IndexedDB` are isolated per instance. Practically: phrases saved while
  testing in a plain Safari tab will **not** appear in the installed
  home-screen app, and vice versa. Always test and use the home-screen
  icon as the real app.
- **No storage guarantee, only a lighter eviction policy.** iOS can still
  evict data under device storage pressure regardless of install state;
  ITP exemption is not the same as a hard persistence guarantee.
- **Push notifications require the home-screen install.** As of iOS 16.4,
  Web Push works only for a site added to the home screen — it does not
  work in a plain Safari tab at all
  ([Apple Developer Forums](https://developer.apple.com/forums/thread/732594)).
  Not used by this app today, but relevant if that's ever wanted.
- **Apple's support for home-screen web apps has been politically, not just
  technically, contingent.** In early 2024 Apple briefly disabled Home
  Screen web apps entirely for EU users during a Digital Markets Act
  dispute, then reversed the change
  ([background](https://blog.tomayac.com/2024/02/28/so-what-exactly-did-apple-break-in-the-eu/)).
  Nothing to act on today, but a reason to periodically re-verify install
  and offline behaviour after major iOS releases rather than assuming it's
  permanent.
