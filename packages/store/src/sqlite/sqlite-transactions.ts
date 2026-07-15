import type { DataStore, StoreTransaction } from "../types.js";
import {
  nestedWithTransactionError,
  SERIALIZED_NESTING_REASON,
} from "../tx-nesting-error.js";
import { createTxNestingGuard } from "../tx-nesting-guard.js";
import type { SqliteConnection } from "./sqlite-types.js";

export type SqliteTransactions = Pick<DataStore, "withTransaction">;

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
 *
 *   INVARIANT the turn pipeline upholds (audit R-07): correctness comes from
 *   *ordering*, not isolation. Every write belonging to a turn (player
 *   message, proposal commits, trace rows, lifecycle sync, auto-snapshot)
 *   runs under that session's lock, and every externally-visible side effect
 *   that used to fire while the commit transaction was open — committed-
 *   proposal events, PostStateCommit hooks, `turn.completed`, post-turn
 *   memory ingestion — is deferred until after `withTransaction` resolves
 *   (see packages/runtime/src/commit/session-commit-pipeline.ts and
 *   `TurnResult.completeTurn`). So no write of turn N can be captured by
 *   turn N's own commit transaction from outside it.
 *
 *   Residual exposure: session locks are per-session, so a non-tx write from
 *   session A issued while session B's transaction is open still folds into
 *   B's transaction — harmless on COMMIT, lost on B's ROLLBACK (rollbacks
 *   only occur on thrown store errors). Eliminating that requires per-tx
 *   connections (as PgStore has); rearchitecting this backend's connection
 *   model is deliberately out of scope.
 * - **Nesting deadlocks, so it is rejected.** Calling `withTransaction` from
 *   inside another `withTransaction` callback would queue the inner call behind
 *   the outer one on the serialization chain — and the outer call is awaiting
 *   the inner — a permanent deadlock. The nesting guard detects this
 *   synchronously (via AsyncLocalStorage) and rejects with a clear error instead
 *   of hanging.
 */
export function createSqliteTransactions(
  sqlite: SqliteConnection,
  getScope: () => StoreTransaction,
): SqliteTransactions {
  let chain: Promise<unknown> = Promise.resolve();
  const nesting = createTxNestingGuard();

  return {
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
