import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import { createIndexedDbDeckStore, createIndexedDbSettingsStore } from './adapters/storage'
import './styles.css'

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('root element not found')
}

const deckStore = createIndexedDbDeckStore()
const settingsStore = createIndexedDbSettingsStore()

createRoot(rootElement).render(
  <StrictMode>
    <App deckStore={deckStore} settingsStore={settingsStore} />
  </StrictMode>,
)
