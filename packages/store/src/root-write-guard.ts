/**
 * Inside a `withTransaction` callback only `tx` writes (docs/reference/transactions.md).
 *
 * The backends disagree about a write that goes through the ROOT store from
 * inside the callback: SQLite runs it on the transaction's connection (it
 * commits or rolls back with the transaction), MemoryStore applies it outside
 * the rollback snapshot, and PostgreSQL commits it at once on another pooled
 * connection. Rather than three meanings, every backend refuses it.
 *
 * Only the async context of a running callback is refused. A caller that
 * merely runs while a transaction is open elsewhere is not inside it: on the
 * serialized backends it still queues behind the transaction.
 */

import { RootStoreWriteInTransactionError } from "./errors.js";

/**
 * Wrap the named methods of a root store so a call from inside one of its
 * transaction callbacks rejects with {@link RootStoreWriteInTransactionError}.
 */
export function rejectRootWritesInTransaction<T extends object>(
  store: T,
  isInTransaction: () => boolean,
  writeMethodNames: ReadonlySet<string>,
): T {
  const guarded = { ...store } as Record<string, unknown>;
  for (const name of Object.keys(guarded)) {
    const original = guarded[name];
    if (typeof original !== "function" || !writeMethodNames.has(name)) {
      continue;
    }
    const fn = original as (...args: unknown[]) => unknown;
    guarded[name] = (...args: unknown[]) =>
      isInTransaction()
        ? Promise.reject(new RootStoreWriteInTransactionError(name))
        : fn.apply(store, args);
  }
  return guarded as T;
}
