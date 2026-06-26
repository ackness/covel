import type { DataStore, StoreTransaction } from "../types.js";
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
      const task = chain.then(async () => {
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
      });
      // Keep the chain alive regardless of this call's outcome.
      chain = task.then(
        () => undefined,
        () => undefined,
      );
      return task;
    },
  };
}
