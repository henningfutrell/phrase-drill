export type PersistenceResult = { supported: boolean; persisted: boolean }

/**
 * Requests durable storage so that iOS Safari's ~7-day IndexedDB eviction
 * (Intelligent Tracking Prevention) does not silently take the whole
 * library. Reports the real outcome honestly — it never claims persistence
 * was granted when it was not, or when the API isn't there to ask.
 */
export async function requestPersistence(
  storage: StorageManager | undefined = globalThis.navigator?.storage,
  log: (message: string) => void = (message) => console.warn(message),
): Promise<PersistenceResult> {
  if (!storage || typeof storage.persist !== 'function') {
    log('navigator.storage.persist() is unavailable; storage may be evicted without warning.')
    return { supported: false, persisted: false }
  }

  try {
    const persisted = await storage.persist()
    if (!persisted) {
      log('Persistent storage was not granted; the library may be evicted after inactivity.')
    }
    return { supported: true, persisted }
  } catch (error) {
    log(`navigator.storage.persist() failed: ${String(error)}`)
    return { supported: false, persisted: false }
  }
}
