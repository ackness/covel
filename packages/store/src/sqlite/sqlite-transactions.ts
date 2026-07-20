import type { DataStore, StoreTransaction } from "../types.js";
import {
  nestedWithTransactionError,
  SERIALIZED_NESTING_REASON,
} from "../tx-nesting-error.js";
import type { SerializedWriteGate } from "../serialized-write-gate.js";
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
 *   ENFORCED INVARIANT — same-session: correctness within one session comes
 *   from *ordering*, not isolation. Every write belonging to a turn (player
 *   message, proposal commits, trace rows, lifecycle sync, auto-snapshot) runs
 *   under that session's lock, and every externally-visible side effect that
 *   used to fire while the commit transaction was open — committed-proposal
 *   events, PostStateCommit hooks, `turn.completed`, post-turn memory
 *   ingestion — is deferred until after `withTransaction` resolves
 *   (`postCommit` fan-out in
 *   packages/runtime/src/commit/session-commit-pipeline.ts and
 *   `TurnResult.completeTurn`). So no write of turn N can be captured by
 *   turn N's own commit transaction from outside it.
 *
 *   CROSS-SESSION / NON-TURN WRITES — now closed by the serialized write gate
 *   (../serialized-write-gate.ts). The session lock is per-session, so a write
 *   from another session, or a non-turn HTTP write holding no session lock at
 *   all (world imports, character edits, settings), used to fold into whatever
 *   transaction happened to be open and vanish if it rolled back. Every
 *   mutating store method now queues on the same chain as `withTransaction`,
 *   so such a write waits for the transaction instead of joining it. Writes
 *   issued from INSIDE the callback still run inline — they belong to that
 *   transaction. Per-transaction connections (as PgStore has) remain the
 *   long-term answer for true concurrency, but the correctness gap is gone.
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
  gate: SerializedWriteGate,
): SqliteTransactions {
  return {
    withTransaction<T>(fn: (tx: StoreTransaction) => Promise<T>): Promise<T> {
      // Synchronous nesting guard — must run at CALL time (before chaining),
      // otherwise the inner call would queue behind the outer transaction that
      // is awaiting it and deadlock. Reject without touching the chain.
      if (gate.isInTransaction()) {
        return Promise.reject(
          nestedWithTransactionError(
            "SqliteStore",
            "sqlite",
            SERIALIZED_NESTING_REASON,
          ),
        );
      }
      return gate.runExclusive(async () => {
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
    },
  };
}
