/**
 * The IndexedDB the storage tests run against: `fake-indexeddb`, a real
 * implementation of the IndexedDB specification, installed as the global
 * `indexedDB` so the real `idb` package and the real adapters run on top of
 * it unmodified. Importing this module is the whole of the setup — there is
 * no `vi.mock('idb', ...)` anywhere any more.
 *
 * **Why a real implementation and not a double (T084).** The two most
 * important fixes in this codebase — `DeckStore.update` (T075) and
 * `DeckStore.updateAll` (T074) — exist for exactly one reason: read/merge/write
 * must be indivisible, so a Phrase she saves while a sync merge is running
 * cannot be computed away and then read by the next merge as a deletion. That
 * guarantee IS IndexedDB's transaction semantics. The hand-rolled double this
 * file used to hold had `abort: () => {}`, `done: Promise.resolve()`, and a
 * `transaction()` that ignored its scope and took no locks, so it could not
 * tell the fixed code from the code before the fix on the property the fixes
 * are about. Under `fake-indexeddb` a `readwrite` transaction really does hold
 * its stores, an abort really does roll back, and `tx.done` really does settle
 * at commit — so those tests fail if anyone moves a read or a write out of the
 * transaction.
 *
 * The one thing a working database will not do on request is fail, so
 * `failNextWriteTo` below injects a refused write. It is a fault injector, not
 * a second fake: the failure is raised through the implementation's own request
 * pipeline, so the abort and the rollback that follow are entirely real.
 */
import 'fake-indexeddb/auto'
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { forceCloseDatabase } from 'fake-indexeddb'
import { unwrap, wrap, type IDBPDatabase, type IDBPTransaction } from 'idb'

/**
 * Every destructive operation IndexedDB has been asked to perform, in order.
 * `delete` and `clear` are the only two ways a record can leave IndexedDB, so
 * this array is the complete record of what a code path was able to destroy —
 * which is what lets a test prove that clip eviction can never reach the
 * `decks`, `mixes`, `settings` or `tombstones` stores (T036). Mutable on
 * purpose: a test that cares about one stretch of work splices it empty first.
 */
export const idbDestructiveOperations: { op: 'delete' | 'clear'; store: string }[] = []

/**
 * Every operation IndexedDB has been asked to perform, in order (T072). Wider
 * than `idbDestructiveOperations` on purpose: the defect this exists to pin is
 * a READ — `getAll` over the whole ~890 MB clip store, which is an
 * out-of-memory crash on a phone and, inside a versionchange transaction, a
 * crashloop that makes her library permanently unreachable. "Which store did
 * this path read whole?" is the question, and only a log of every op can
 * answer it. Mutable, like the one above: splice it empty to scope a test.
 */
export const idbOperations: {
  op: 'get' | 'getAll' | 'getAllKeys' | 'count' | 'put' | 'delete' | 'clear'
  store: string
  /** Which transaction carried it — see `idbTransactions`. */
  transaction: number
}[] = []

/**
 * The transactions those operations ran on, by the id in `idbOperations`
 * (T084). What a transaction HOLDS is the whole of T074's and T075's claim,
 * and it is not observable from the values in the stores afterwards: "the read
 * and the write are one transaction" and "the transaction spans all three
 * stores" are facts about the transaction, so a test that wants to pin them has
 * to be able to name it. Cleared by `resetFakeIdb` with everything else.
 */
export const idbTransactions = new Map<number, { mode: string; stores: string[] }>()

const transactionIds = new WeakMap<IDBTransaction, number>()
let nextTransactionId = 1

function identify(tx: IDBTransaction): number {
  const known = transactionIds.get(tx)
  if (known !== undefined) return known
  const id = nextTransactionId
  nextTransactionId += 1
  transactionIds.set(tx, id)
  idbTransactions.set(id, { mode: tx.mode, stores: [...tx.objectStoreNames] })
  return id
}

/**
 * The log is taken on `IDBObjectStore` itself rather than on a wrapper around
 * `idb`, so it records what actually reached the database — including anything
 * `idb` issues on the adapter's behalf. Installed once, at import.
 */
const LOGGED_OPERATIONS = ['get', 'getAll', 'getAllKeys', 'count', 'put', 'delete', 'clear'] as const

let armedWriteFailure: { store: string; name: string } | undefined

/**
 * Make the next `put` against `store` fail the way a phone under storage
 * pressure fails — the one condition a working database cannot be asked to
 * produce, and the one the restore path's "nothing was replaced" promise is
 * about (T072, T074).
 *
 * The error is raised from inside the request's own operation, so IndexedDB
 * handles it exactly as it handles a genuine `QuotaExceededError`: the request
 * fires `error`, nothing preventDefaults it, and the transaction aborts and
 * rolls back. Nothing about the abort or the rollback under test is simulated.
 * Cleared by `resetFakeIdb`.
 *
 * **It also absorbs the transaction's `done` rejection, and that is a finding,
 * not a convenience.** `update`, `updateAll` and `importAll` each read `tx.done`
 * on the path where they abort deliberately, and none of them reads it on the
 * path where a WRITE fails: the failing `put` rejects, the function throws, and
 * `tx.done` is left rejecting with `AbortError` that nothing awaits. On her
 * phone that reaches `error-capture.ts`'s `unhandledrejection` handler and is
 * logged as a captured error on top of the failure she was already shown. No
 * record is at risk — the rollback itself is correct, which is what the tests
 * using this assert — so it is recorded here rather than fixed under a task
 * about test infrastructure.
 */
export function failNextWriteTo(store: string, name = 'QuotaExceededError'): void {
  armedWriteFailure = { store, name }
}

type RequestPipeline = {
  _execRequestAsync(request: { operation: () => unknown; source: unknown }): unknown
}

for (const op of LOGGED_OPERATIONS) {
  const original = IDBObjectStore.prototype[op] as (...args: unknown[]) => unknown
  Object.defineProperty(IDBObjectStore.prototype, op, {
    configurable: true,
    writable: true,
    value: function instrumented(this: IDBObjectStore, ...args: unknown[]) {
      idbOperations.push({ op, store: this.name, transaction: identify(this.transaction) })
      if (op === 'delete' || op === 'clear') {
        idbDestructiveOperations.push({ op, store: this.name })
      }
      if (op === 'put' && armedWriteFailure?.store === this.name) {
        const { name } = armedWriteFailure
        armedWriteFailure = undefined
        // See `failNextWriteTo` — the adapter leaves this promise rejecting.
        void (wrap(this.transaction) as IDBPTransaction).done.catch(() => {})
        return (this.transaction as unknown as RequestPipeline)._execRequestAsync({
          source: this,
          operation: () => {
            const error = new Error(`${name}: the write was refused`)
            error.name = name
            throw error
          },
        })
      }
      return original.apply(this, args)
    },
  })
}

/**
 * Call between tests — the equivalent of deleting every IndexedDB database.
 * A whole new factory rather than a sweep of `deleteDatabase` calls, so a
 * connection a previous test left open cannot block the next test's upgrade.
 */
export function resetFakeIdb(): void {
  globalThis.indexedDB = new IDBFactory()
  idbDestructiveOperations.length = 0
  idbOperations.length = 0
  idbTransactions.clear()
  armedWriteFailure = undefined
}

/**
 * Let the real event loop turn, repeatedly, so anything IndexedDB has queued
 * gets to run. `await Promise.resolve()` is not enough: a real implementation
 * settles requests from event-loop tasks, not from microtasks, so a test that
 * wants to say "this write did NOT land" has to give it every chance to.
 */
export async function settleIdb(turns = 20): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

/**
 * Be the browser closing a connection without being asked — what `terminated`
 * reports. The real event, fired by the real implementation, rather than a
 * callback a double kept a reference to.
 */
export function terminateConnection(db: IDBPDatabase): void {
  forceCloseDatabase(unwrap(db) as unknown as Parameters<typeof forceCloseDatabase>[0])
}
