import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import { createIndexedDbDeckStore, createIndexedDbSettingsStore } from './adapters/storage'
import { createElevenLabsSynthClient } from './adapters/audio/eleven-labs-synth-client'
import './styles.css'

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('root element not found')
}

const deckStore = createIndexedDbDeckStore()
const settingsStore = createIndexedDbSettingsStore()
const synthClient = createElevenLabsSynthClient({
  getApiKey: () => settingsStore.load().then((settings) => settings.elevenLabsApiKey),
})

createRoot(rootElement).render(
  <StrictMode>
    <App deckStore={deckStore} settingsStore={settingsStore} synthClient={synthClient} />
  </StrictMode>,
)
