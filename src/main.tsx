import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import { createIndexedDbClipCache, createIndexedDbDeckStore, createIndexedDbSettingsStore } from './adapters/storage'
import { createElevenLabsSynthClient } from './adapters/audio/eleven-labs-synth-client'
import { createGenerationQueue } from './adapters/audio/generation-queue'
import './styles.css'

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('root element not found')
}

const deckStore = createIndexedDbDeckStore()
const settingsStore = createIndexedDbSettingsStore()
const clipCache = createIndexedDbClipCache()
const synthClient = createElevenLabsSynthClient({
  getApiKey: () => settingsStore.load().then((settings) => settings.elevenLabsApiKey),
})
const generationQueue = createGenerationQueue({
  synthClient,
  clipCache,
  getVoice: () => settingsStore.load().then((settings) => settings.voice),
})

createRoot(rootElement).render(
  <StrictMode>
    <App
      deckStore={deckStore}
      settingsStore={settingsStore}
      synthClient={synthClient}
      generationQueue={generationQueue}
      clipCache={clipCache}
    />
  </StrictMode>,
)
