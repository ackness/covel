/**
 * PgStore transaction adapter.
 *
 * postgres.js is a connection pool, so a bare `unsafe('BEGIN')` does not bind
 * to a specific connection. Drizzle's own `db.transaction(async (tx) => ...)`
 * API handles reservation + BEGIN/COMMIT/ROLLBACK correctly, but it is
 * callback-shaped. This module adapts that callback API to the imperative
 * `beginTx / commitTx / rollbackTx` contract that the `DataStore` interface
 * requires by spawning `pooledDb.transaction` in the background and gating
 * its completion on a manually-resolved promise:
 *
 * - `commitTx()` resolves the gate → the callback returns cleanly → drizzle COMMITs
 * - `rollbackTx()` rejects the gate with a sentinel → the callback throws →
 *   drizzle issues ROLLBACK and rethrows → we swallow the sentinel
 *
 * While a transaction is active, the adapter pushes the drizzle tx handle
 * back into the caller's closure via `setDb` so every data method routes
 * through the transaction. On completion it restores the pooled handle.
 */

import type { drizzle } from "drizzle-orm/postgres-js";

// `typeof drizzle(...)` — kept permissive so pg-store.ts can supply its own
// schema-bound type without forcing this module to know about the schema.
type PooledDb = ReturnType<typeof drizzle>;

/** Unforgeable marker used to distinguish a cooperative rollback from a real error. */
export const ROLLBACK_SENTINEL: unique symbol = Symbol("covel-pg-rollback");

interface RollbackSentinelError {
  readonly _covelRollback: typeof ROLLBACK_SENTINEL;
  readonly message: string;
}

function isRollbackSentinel(err: unknown): err is RollbackSentinelError {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { _covelRollback?: symbol })._covelRollback === ROLLBACK_SENTINEL
  );
}

export interface PgTxAdapterDeps<TDb extends PooledDb> {
  /** The pool-bound drizzle handle used outside transactions. */
  readonly pooledDb: TDb;
  /**
   * Callback invoked whenever the "current db" handle must change.
   * During `beginTx` it is called with the tx-scoped handle; on completion
   * (commit/rollback/error) it is called back with `pooledDb` to restore
   * pool-mode operation.
   */
  readonly setDb: (db: TDb) => void;
}

export interface PgTxAdapter {
  beginTx(): Promise<void>;
  commitTx(): Promise<void>;
  rollbackTx(): Promise<void>;
  /**
   * Best-effort rollback of any in-flight transaction. Used by `store.close()`
   * to avoid leaking a reserved connection when the store is torn down
   * mid-transaction.
   */
  closeActiveTx(): Promise<void>;
}

export function createPgTxAdapter<TDb extends PooledDb>(
  deps: PgTxAdapterDeps<TDb>,
): PgTxAdapter {
  const { pooledDb, setDb } = deps;

  interface ActiveTx {
    readonly done: Promise<void>;
    readonly resolveGate: () => void;
    readonly rejectGate: (err: unknown) => void;
  }

  let activeTx: ActiveTx | null = null;

  async function beginTx(): Promise<void> {
    if (activeTx !== null) {
      throw new Error(
        "PgStore: nested transactions are not supported (beginTx called while another tx is active)",
      );
    }

    // Gate that the drizzle transaction callback awaits. Resolving it lets
    // the callback return cleanly (→ drizzle COMMITs). Rejecting it with
    // the sentinel makes the callback throw (→ drizzle ROLLBACKs).
    let resolveGate!: () => void;
    let rejectGate!: (err: unknown) => void;
    const gate = new Promise<void>((resolve, reject) => {
      resolveGate = resolve;
      rejectGate = reject;
    });

    // Promise that resolves once the tx callback has installed the tx-scoped
    // db handle. `beginTx` waits on this before returning so callers see a
    // ready tx state.
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });

    const done = pooledDb
      .transaction(async (tx) => {
        setDb(tx as unknown as TDb);
        resolveReady();
        await gate;
      })
      .then(
        () => undefined,
        (err: unknown) => {
          if (isRollbackSentinel(err)) {
            return undefined;
          }
          throw err;
        },
      )
      .finally(() => {
        setDb(pooledDb);
        activeTx = null;
      });

    activeTx = { done, resolveGate, rejectGate };

    // If the tx setup itself fails before `ready` resolves, surface that error.
    await Promise.race([
      ready,
      done.then(() => {
        throw new Error("PgStore: transaction ended before beginTx completed");
      }),
    ]);
  }

  async function commitTx(): Promise<void> {
    if (activeTx === null) {
      throw new Error("PgStore: commitTx called without an active transaction");
    }
    const tx = activeTx;
    tx.resolveGate();
    await tx.done;
  }

  async function rollbackTx(): Promise<void> {
    if (activeTx === null) {
      throw new Error(
        "PgStore: rollbackTx called without an active transaction",
      );
    }
    const tx = activeTx;
    tx.rejectGate({
      _covelRollback: ROLLBACK_SENTINEL,
      message: "covel rollback",
    });
    await tx.done;
  }

  async function closeActiveTx(): Promise<void> {
    if (activeTx === null) return;
    const tx = activeTx;
    try {
      tx.rejectGate({
        _covelRollback: ROLLBACK_SENTINEL,
        message: "covel rollback (close)",
      });
      await tx.done;
    } catch {
      // swallow — best-effort cleanup
    }
  }

  return { beginTx, commitTx, rollbackTx, closeActiveTx };
}
