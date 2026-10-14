/**
 * AsyncLocalStorage-based re-entrancy guard for `DataStore.withTransaction`.
 *
 * Used by the Node backends (SqliteStore, MemoryStore, PgStore) to distinguish a
 * *nested* `withTransaction` call — issued from inside another transaction's
 * callback — from a genuinely *concurrent* call issued by an independent caller.
 *
 * Why AsyncLocalStorage rather than a plain boolean: the serialized backends
 * keep a transaction's callback "active" across its own `await` points. A plain
 * boolean set for that whole lifetime would also be observed as `true` by a
 * genuinely concurrent caller that happens to start while another transaction is
 * suspended at an await — a false positive that would reject legitimate
 * concurrency. AsyncLocalStorage instead marks only the async context of the
 * running callback, so `isNested()` returns `true` exclusively for re-entrant
 * (nested) calls and `false` for independent concurrent ones.
 *
 * Node-only: this module imports `node:async_hooks`; browser-private storage
 * uses BrowserVault and does not implement the DataStore transaction contract.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface TxNestingGuard {
  /**
   * True iff called from within a `runScoped` callback's async context while
   * that callback has not settled yet.
   */
  readonly isNested: () => boolean;
  /** Run `fn` marked as an active transaction scope (propagates through awaits). */
  readonly runScoped: <T>(fn: () => Promise<T>) => Promise<T>;
}

export function createTxNestingGuard(): TxNestingGuard {
  // The scope object outlives the callback in every continuation it started;
  // clearing `open` when the callback settles lets work that runs after the
  // transaction (a timer, a detached promise) count as outside it.
  const scope = new AsyncLocalStorage<{ open: boolean }>();
  return {
    isNested: () => scope.getStore()?.open === true,
    runScoped: <T>(fn: () => Promise<T>): Promise<T> => {
      const marker = { open: true };
      return scope.run(marker, async () => {
        try {
          return await fn();
        } finally {
          marker.open = false;
        }
      });
    },
  };
}
