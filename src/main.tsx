import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import { createIndexedDbClipCache, createIndexedDbDeckStore, createIndexedDbSettingsStore } from './adapters/storage'
import { createServerSynthClient } from './adapters/audio/server-synth-client'
import { createGenerationQueue } from './adapters/audio/generation-queue'
import { createServerScanReader } from './adapters/vision/server-scan-reader'
import { createLibrarySyncClient } from './adapters/sync/library-sync-client'
import { createSessionAuth, AuthRequiredError } from './adapters/auth/session-auth'
import { LoginScreen } from './ui/LoginScreen'
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
// T050: the device holds no provider key to redact any more, and its one
// credential — an opaque session token, held in `localStorage` by
// session-auth.ts — is a bearer credential, not a server secret; logging
// one is not the same failure class as logging a provider key.
const errorLog = createIndexedDbErrorLog({ getSecrets: () => Promise.resolve([]) })
installErrorCapture(errorLog)

// T050: replaces the Keycloak/PKCE flow entirely — a plain login form
// posted to this app's own /api/login, in exchange for an opaque session
// token this device stores itself. `render()` is called once at boot and
// again by `showApp()`/`showLogin()` below, whichever the current auth
// state calls for; there is no client-side router, same as the rest of the
// app (App.tsx switches screens by state, never a URL).
const auth = createSessionAuth({ onUnauthorized: () => showLogin() })

function renderRoot(children: ReactNode): void {
  createRoot(rootElement as HTMLElement).render(<StrictMode>{children}</StrictMode>)
}

function showLogin(): void {
  renderRoot(
    <LoginScreen
      onLogin={async (username, password) => {
        const result = await auth.login(username, password)
        if (result.ok) showApp()
        return result
      }}
    />,
  )
}

async function getAccessToken(): Promise<string> {
  return auth.getAccessToken()
}

function showApp(): void {
  const rawSynthClient = createServerSynthClient({ getAccessToken, fetchImpl: auth.authFetch })
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
  const rawScanReader = createServerScanReader({ getAccessToken, fetchImpl: auth.authFetch })
  const scanReader = {
    ...rawScanReader,
    read: withAdapterErrorLogging('scan', rawScanReader.read.bind(rawScanReader), errorLog),
  }
  const librarySyncClient = createLibrarySyncClient({ getAccessToken, fetchImpl: auth.authFetch })

  renderRoot(
    <App
      deckStore={deckStore}
      settingsStore={settingsStore}
      synthClient={synthClient}
      generationQueue={generationQueue}
      clipCache={clipCache}
      scanReader={scanReader}
      errorLog={errorLog}
      librarySyncClient={librarySyncClient}
    />,
  )
}

async function boot(): Promise<void> {
  try {
    await auth.getAccessToken()
    showApp()
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      showLogin()
      return
    }
    throw err
  }
}

void boot()
