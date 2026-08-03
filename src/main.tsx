import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import { createIndexedDbClipCache, createIndexedDbDeckStore, createIndexedDbSettingsStore } from './adapters/storage'
import { createServerSynthClient } from './adapters/audio/server-synth-client'
import { createGenerationQueue } from './adapters/audio/generation-queue'
import { createServerScanReader } from './adapters/vision/server-scan-reader'
import { createLibrarySyncClient } from './adapters/sync/library-sync-client'
import { createKeycloakAuth, AuthRequiredError } from './adapters/auth/keycloak-auth'
import { createIndexedDbErrorLog, installErrorCapture, withAdapterErrorLogging } from './adapters/diagnostics'
import './styles.css'

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('root element not found')
}

const deckStore = createIndexedDbDeckStore()
const settingsStore = createIndexedDbSettingsStore()
const clipCache = createIndexedDbClipCache()

// Diagnostics (T039): the ring buffer that backs Diagnostics and the two
// global error hooks that feed it. Installed here, at the composition root,
// not scattered through components (AGENTS.md ports-and-adapters, T039).
// T043: the device holds no provider key or library key to redact any more
// — its one credential is a Keycloak access token, held in memory by
// keycloak-auth.ts and never written to a Deck/Phrase/diagnostics record.
const errorLog = createIndexedDbErrorLog({ getSecrets: () => Promise.resolve([]) })
installErrorCapture(errorLog)

// Realm/client come from Vite build-time env (VITE_-prefixed, baked into
// the static build — Dockerfile/docker-compose.yml `build.args`), same as
// any other public OAuth client config. `redirectUri` is the page itself:
// Keycloak sends the browser straight back to wherever the PWA is served.
const auth = createKeycloakAuth({
  issuerUrl: import.meta.env.VITE_KEYCLOAK_URL ?? 'http://localhost:8081',
  realm: import.meta.env.VITE_KEYCLOAK_REALM ?? 'phrase-drill',
  clientId: import.meta.env.VITE_KEYCLOAK_CLIENT_ID ?? 'phrase-drill-app',
  redirectUri: `${window.location.origin}/`,
})

async function getAccessToken(): Promise<string> {
  try {
    return await auth.getAccessToken()
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      await auth.login() // full-page redirect — never resolves
      return await new Promise<string>(() => {})
    }
    throw err
  }
}

async function boot(): Promise<void> {
  // Completes the PKCE round trip if this load is Keycloak redirecting
  // back with `?code=...&state=...`; a no-op on every other load.
  await auth.handleRedirectCallback(window.location.href)
  if (window.location.search.includes('code=')) {
    window.history.replaceState({}, '', window.location.pathname)
  }
  try {
    await auth.getAccessToken()
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      await auth.login()
      return // login() redirects the page away; nothing below ever runs
    }
    throw err
  }

  const rawSynthClient = createServerSynthClient({ getAccessToken })
  const synthClient = {
    ...rawSynthClient,
    synthesize: withAdapterErrorLogging('synth', rawSynthClient.synthesize.bind(rawSynthClient), errorLog),
  }
  const generationQueue = createGenerationQueue({
    synthClient,
    clipCache,
    getVoice: () => settingsStore.load().then((settings) => settings.voice),
    // Failures already surface through Diagnostics via the synthClient wrap
    // above (every generateOne call goes through it); this hook additionally
    // logs the queue's own final unauthorized/quota/failed verdict per Phrase,
    // which is the fact a report actually needs ("generation is stuck"), not
    // just the raw synth error.
    onStatusChange: (phraseId, status) => {
      if (status.kind === 'unauthorized' || status.kind === 'quota' || status.kind === 'failed') {
        void errorLog.record({
          timestamp: Date.now(),
          source: 'adapter',
          message: `generation ${status.kind} for phrase ${phraseId}`,
        })
      }
    },
  })
  const rawScanReader = createServerScanReader({ getAccessToken })
  const scanReader = {
    ...rawScanReader,
    read: withAdapterErrorLogging('scan', rawScanReader.read.bind(rawScanReader), errorLog),
  }
  const librarySyncClient = createLibrarySyncClient({ getAccessToken })

  createRoot(rootElement as HTMLElement).render(
    <StrictMode>
      <App
        deckStore={deckStore}
        settingsStore={settingsStore}
        synthClient={synthClient}
        generationQueue={generationQueue}
        clipCache={clipCache}
        scanReader={scanReader}
        errorLog={errorLog}
        librarySyncClient={librarySyncClient}
      />
    </StrictMode>,
  )
}

void boot()
