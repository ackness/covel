import type { DataStore, StoreTransaction } from "../types.js";
import {
  nestedWithTransactionError,
  SERIALIZED_NESTING_REASON,
} from "../tx-nesting-error.js";
import { createTxNestingGuard } from "../tx-nesting-guard.js";
import type { SqliteConnection } from "./sqlite-types.js";

export type SqliteTransactions = Pick<
  DataStore,
  "beginTx" | "commitTx" | "rollbackTx" | "withTransaction"
>;

/**
 * better-sqlite3 is a single synchronous connection, so it cannot hold two
 * concurrent transactions. `withTransaction` therefore *serializes* concurrent
 * calls through a promise chain — each runs its full BEGIN…COMMIT before the
 * next starts, so neither loses writes. The tx scope is the same data-method
 * store (one connection); no shared handle is swapped.
 *
 * Two important caveats follow from the single connection:
 *
 * - **Concurrent non-tx writes are folded in.** While a `withTransaction`
 *   callback is mid-flight (between BEGIN and COMMIT), any other write issued on
 *   this same store — including writes that do NOT go through `withTransaction`
 *   — runs on the open transaction and is committed or rolled back with it.
 *   Callers must not interleave unrelated writes with a serialized transaction.
 * - **Nesting deadlocks, so it is rejected.** Calling `withTransaction` from
 *   inside another `withTransaction` callback would queue the inner call behind
 *   the outer one on the serialization chain — and the outer call is awaiting
 *   the inner — a permanent deadlock. The nesting guard detects this
 *   synchronously (via AsyncLocalStorage) and rejects with a clear error instead
 *   of hanging.
 *
 * The imperative `beginTx/commitTx/rollbackTx` shim is preserved unchanged for
 * existing callers (a process-level boolean guards against nesting). Mixing a
 * concurrent imperative transaction with `withTransaction` is rejected rather
 * than silently corrupting the single connection.
 */
export function createSqliteTransactions(
  sqlite: SqliteConnection,
  getScope: () => StoreTransaction,
): SqliteTransactions {
  let imperativeActive = false;
  let chain: Promise<unknown> = Promise.resolve();
  const nesting = createTxNestingGuard();

  return {
    async beginTx(): Promise<void> {
      if (imperativeActive) {
        throw new Error(
          "SqliteStore: nested transactions are not supported (beginTx called while another tx is active)",
        );
      }
      sqlite.exec("BEGIN");
      imperativeActive = true;
    },

    async commitTx(): Promise<void> {
      if (!imperativeActive) {
        throw new Error(
          "SqliteStore: commitTx called without an active transaction",
        );
      }
      // Reset the flag in finally so a throwing COMMIT still clears state; the
      // next beginTx can recover instead of reporting a phantom active tx.
      try {
        sqlite.exec("COMMIT");
      } finally {
        imperativeActive = false;
      }
    },

    async rollbackTx(): Promise<void> {
      if (!imperativeActive) {
        throw new Error(
          "SqliteStore: rollbackTx called without an active transaction",
        );
      }
      try {
        sqlite.exec("ROLLBACK");
      } finally {
        imperativeActive = false;
      }
    },

    withTransaction<T>(fn: (tx: StoreTransaction) => Promise<T>): Promise<T> {
      // Synchronous nesting guard — must run at CALL time (before chaining),
      // otherwise the inner call would queue behind the outer transaction that
      // is awaiting it and deadlock. Reject without touching the chain.
      if (nesting.isNested()) {
        return Promise.reject(
          nestedWithTransactionError(
            "SqliteStore",
            "sqlite",
            SERIALIZED_NESTING_REASON,
          ),
        );
      }
      const task = chain.then(() =>
        nesting.runScoped(async () => {
          if (imperativeActive) {
            throw new Error(
              "SqliteStore: withTransaction cannot start while an imperative transaction is active",
            );
          }
          sqlite.exec("BEGIN");
          try {
            const result = await fn(getScope());
            sqlite.exec("COMMIT");
            return result;
          } catch (err) {
            try {
              sqlite.exec("ROLLBACK");
            } catch {
              // A failed ROLLBACK must not mask the original error.
            }
            throw err;
          }
        }),
      );
      // Keep the chain alive regardless of this call's outcome.
      chain = task.then(
        () => undefined,
        () => undefined,
      );
      return task;
    },
  };
}
