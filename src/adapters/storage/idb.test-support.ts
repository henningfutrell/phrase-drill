/**
 * Test-only in-memory substitute for the `idb` package's public surface.
 * Used via `vi.mock('idb', ...)` so the real adapter code (indexed-db-deck-
 * store.ts) runs against something that behaves like IndexedDB, without a
 * browser. This mocks the external unmanaged dependency at its seam — it is
 * not a fake DeckStore; the DeckStore implementation under test is real.
 *
 * Deliberately minimal: only the operations the adapter actually calls.
 */

type StoreOps = {
  get(key: unknown): Promise<unknown>
  getAll(): Promise<unknown[]>
  put(value: unknown, key?: unknown): Promise<unknown>
  delete(key: unknown): Promise<void>
  clear(): Promise<void>
}

type FakeDatabase = {
  version: number
  stores: Map<string, Map<unknown, unknown>>
  keyPaths: Map<string, string | undefined>
}

const databases = new Map<string, FakeDatabase>()

/** Call between tests — the equivalent of deleting every IndexedDB database. */
export function resetFakeIdb(): void {
  databases.clear()
}

function recordKey(db: FakeDatabase, storeName: string, value: unknown): unknown {
  const keyPath = db.keyPaths.get(storeName)
  if (!keyPath) {
    throw new Error(`fake idb: store "${storeName}" has no keyPath; pass an explicit key`)
  }
  return (value as Record<string, unknown>)[keyPath]
}

function storeOps(db: FakeDatabase, storeName: string): StoreOps {
  const store = db.stores.get(storeName)
  if (!store) {
    throw new Error(`fake idb: no such store "${storeName}"`)
  }
  return {
    async get(key) {
      return store.get(key)
    },
    async getAll() {
      return [...store.values()]
    },
    async put(value, key) {
      const resolvedKey = key ?? recordKey(db, storeName, value)
      store.set(resolvedKey, value)
      return resolvedKey
    },
    async delete(key) {
      store.delete(key)
    },
    async clear() {
      store.clear()
    },
  }
}

type UpgradeCallback = (
  db: {
    objectStoreNames: { contains(name: string): boolean }
    createObjectStore(name: string, options?: { keyPath?: string }): StoreOps
  },
  oldVersion: number,
  newVersion: number | null,
  transaction: { objectStore(name: string): StoreOps },
) => void | Promise<void>

export async function openDB(
  name: string,
  version: number,
  callbacks?: { upgrade?: UpgradeCallback },
): Promise<{
  objectStoreNames: { contains(name: string): boolean }
  get(storeName: string, key: unknown): Promise<unknown>
  getAll(storeName: string): Promise<unknown[]>
  put(storeName: string, value: unknown, key?: unknown): Promise<unknown>
  delete(storeName: string, key: unknown): Promise<void>
  clear(storeName: string): Promise<void>
  transaction(
    storeNames: string | string[],
    mode?: string,
  ): { store: StoreOps; objectStore(name: string): StoreOps; done: Promise<void> }
}> {
  let db = databases.get(name)
  const oldVersion = db?.version ?? 0

  if (!db || db.version < version) {
    db = db ?? { version, stores: new Map(), keyPaths: new Map() }
    db.version = version
    databases.set(name, db)

    const dbHandle = {
      objectStoreNames: { contains: (storeName: string) => db!.stores.has(storeName) },
      createObjectStore(storeName: string, options?: { keyPath?: string }) {
        db!.stores.set(storeName, new Map())
        db!.keyPaths.set(storeName, options?.keyPath)
        return storeOps(db!, storeName)
      },
    }
    const transaction = { objectStore: (storeName: string) => storeOps(db!, storeName) }
    await callbacks?.upgrade?.(dbHandle, oldVersion, version, transaction)
  }

  const liveDb = db
  return {
    objectStoreNames: { contains: (storeName: string) => liveDb.stores.has(storeName) },
    get: (storeName, key) => storeOps(liveDb, storeName).get(key),
    getAll: (storeName) => storeOps(liveDb, storeName).getAll(),
    put: (storeName, value, key) => storeOps(liveDb, storeName).put(value, key),
    delete: (storeName, key) => storeOps(liveDb, storeName).delete(key),
    clear: (storeName) => storeOps(liveDb, storeName).clear(),
    transaction: (storeNames) => {
      const names = Array.isArray(storeNames) ? storeNames : [storeNames]
      return {
        store: storeOps(liveDb, names[0]),
        objectStore: (storeName: string) => storeOps(liveDb, storeName),
        done: Promise.resolve(),
      }
    },
  }
}
