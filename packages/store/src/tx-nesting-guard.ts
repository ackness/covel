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
 * Node-only: this module imports `node:async_hooks` and must never be pulled
 * into the browser `IdbStore` bundle. IdbStore uses a coarser synchronous
 * boolean flag instead (its single-user local mode makes the concurrent
 * false-positive edge irrelevant, and AsyncLocalStorage is unavailable there).
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface TxNestingGuard {
  /** True iff called synchronously from within a `runScoped` callback's async context. */
  readonly isNested: () => boolean;
  /** Run `fn` marked as an active transaction scope (propagates through awaits). */
  readonly runScoped: <T>(fn: () => Promise<T>) => Promise<T>;
}

export function createTxNestingGuard(): TxNestingGuard {
  const scope = new AsyncLocalStorage<true>();
  return {
    isNested: () => scope.getStore() === true,
    runScoped: <T>(fn: () => Promise<T>): Promise<T> => scope.run(true, fn),
  };
}
