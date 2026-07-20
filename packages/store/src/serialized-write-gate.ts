/**
 * Write serialization for single-connection backends (SqliteStore,
 * MemoryStore).
 *
 * These backends run every operation on ONE connection / one in-memory state,
 * so `withTransaction` cannot isolate: while a transaction is open, any write
 * issued elsewhere on the same store lands inside it and is committed — or
 * silently LOST — with it. The session lock serializes writes belonging to one
 * session's turn, but it is per-session and some routes hold no session lock
 * at all (world imports, character edits, settings), so a write from session B
 * could vanish when session A's transaction rolled back.
 *
 * The gate closes that by making writes and transactions share one queue:
 *
 *   - a transaction takes the queue for its whole BEGIN…COMMIT span;
 *   - a write issued from OUTSIDE any transaction waits for the queue, so it
 *     can never be folded into someone else's open transaction;
 *   - a write issued from INSIDE the transaction callback passes straight
 *     through (it is supposed to be part of that transaction, and queueing it
 *     would deadlock against the transaction awaiting it).
 *
 * Inside/outside is decided by AsyncLocalStorage rather than a boolean so a
 * genuinely concurrent caller that starts while a transaction is suspended at
 * an await is not mistaken for a nested one.
 *
 * Cost is structural, not throughput: better-sqlite3 is synchronous, so its
 * statements were already serialized; what changes is that a write now waits
 * for an in-flight transaction instead of joining it. PgStore needs none of
 * this — it runs each transaction on its own pooled connection.
 */

import { createTxNestingGuard } from "./tx-nesting-guard.js";

export interface SerializedWriteGate {
  /** True iff called synchronously from within a transaction callback. */
  readonly isInTransaction: () => boolean;
  /** Run `fn` as the exclusive queue holder, marked as a transaction scope. */
  readonly runExclusive: <T>(fn: () => Promise<T>) => Promise<T>;
  /**
   * Wrap a store's mutating methods so each awaits the queue when called from
   * outside a transaction. Method names come from `writeMethodNames`; unknown
   * names (reads) are returned untouched.
   */
  readonly gateWrites: <T extends object>(
    store: T,
    writeMethodNames: ReadonlySet<string>,
  ) => T;
}

export function createSerializedWriteGate(): SerializedWriteGate {
  let chain: Promise<unknown> = Promise.resolve();
  const nesting = createTxNestingGuard();

  /** Queue `fn` behind everything already on the chain. */
  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const task = chain.then(fn);
    chain = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  return {
    isInTransaction: nesting.isNested,

    runExclusive<T>(fn: () => Promise<T>): Promise<T> {
      return enqueue(() => nesting.runScoped(fn));
    },

    gateWrites<T extends object>(
      store: T,
      writeMethodNames: ReadonlySet<string>,
    ): T {
      const gated = { ...store } as Record<string, unknown>;
      for (const name of Object.keys(gated)) {
        const original = gated[name];
        if (typeof original !== "function" || !writeMethodNames.has(name)) {
          continue;
        }
        const fn = original as (...args: unknown[]) => unknown;
        gated[name] = (...args: unknown[]) => {
          // Already inside the transaction that owns the queue — run inline.
          if (nesting.isNested()) return fn.apply(store, args);
          return enqueue(async () => fn.apply(store, args));
        };
      }
      return gated as T;
    },
  };
}
