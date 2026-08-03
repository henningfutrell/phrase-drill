import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import { createIndexedDbClipCache, createIndexedDbDeckStore, createIndexedDbSettingsStore } from './adapters/storage'
import { createServerSynthClient } from './adapters/audio/server-synth-client'
import { createGenerationQueue } from './adapters/audio/generation-queue'
import { createServerScanReader } from './adapters/vision/server-scan-reader'
import { createLibrarySyncClient } from './adapters/sync/library-sync-client'
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
// T041: the device holds no provider key to redact any more — its one
// credential is the library key, and that is deliberately shown in the open
// in Settings (it is the recovery mechanism), so it is not treated as a
// secret to strip from diagnostics either.
const errorLog = createIndexedDbErrorLog({ getSecrets: () => Promise.resolve([]) })
installErrorCapture(errorLog)

const getLibraryKey = () => settingsStore.load().then((settings) => settings.libraryKey)

const rawSynthClient = createServerSynthClient({ getLibraryKey })
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
const rawScanReader = createServerScanReader({ getLibraryKey })
const scanReader = {
  ...rawScanReader,
  read: withAdapterErrorLogging('scan', rawScanReader.read.bind(rawScanReader), errorLog),
}
const librarySyncClient = createLibrarySyncClient({ getLibraryKey })

createRoot(rootElement).render(
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
