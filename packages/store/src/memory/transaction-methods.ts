import type { StoreTransaction } from "../types.js";
import { SESSION_SCOPED_TABLES } from "../table-registry.js";
import type { MemoryCollectionKind } from "../table-registry.js";
import {
  nestedWithTransactionError,
  SERIALIZED_NESTING_REASON,
} from "../tx-nesting-error.js";
import { createTxNestingGuard } from "../tx-nesting-guard.js";
import {
  replaceArrayContents,
  replaceMapContents,
} from "./collection-helpers.js";
import type { MemoryState, MemoryStoreMethods } from "./memory-types.js";

/**
 * The MemoryState collections captured by a transaction snapshot.
 *
 * Derived from {@link SESSION_SCOPED_TABLES} (so a newly-registered session
 * table is snapshotted automatically) plus the parent `sessions` map and the
 * non-session-scoped mutable collections (`worlds`, `vectorRows`) a transaction
 * may also touch. `tests/table-registry-consistency.test.ts` pins this list
 * against the registry.
 */
export const MEMORY_SNAPSHOT_COLLECTIONS: ReadonlyArray<{
  readonly key: keyof MemoryState;
  readonly kind: MemoryCollectionKind;
}> = [
  { key: "sessions", kind: "map" },
  ...SESSION_SCOPED_TABLES.map((t) => ({
    key: t.memoryKey as keyof MemoryState,
    kind: t.memoryKind,
  })),
  // Non-session-scoped mutable collections a transaction may also write.
  { key: "worlds", kind: "map" },
  { key: "vectorRows", kind: "map" },
];

/** A captured snapshot: collection key → shallow copy of its contents. */
type MemorySnapshot = Map<keyof MemoryState, unknown>;

/**
 * Capture a transaction snapshot.
 *
 * Performance (audit 2026-06-04 finding H3): instead of `structuredClone`-ing
 * every collection (O(total-bytes) per transaction), we take a *shallow* copy of
 * each collection — a fresh `Map`/array holding the same record references. This
 * is O(row-count) reference copy, not a byte deep clone.
 *
 * Correctness invariant this relies on: MemoryStore methods never mutate a
 * stored record object in place. Every write path either pushes a new object,
 * `.set(key, newObject)`, replaces an array slot with a spread copy
 * (`arr[i] = { ...arr[i], ... }`), or `.delete()`s. A `Map`/array shallow copy
 * therefore preserves the exact membership at snapshot time, and `restoreSnapshot`
 * rewinds structure (insertions, deletions, slot replacements) faithfully — the
 * shared record references it restores were never mutated, so isolation and
 * rollback semantics are unchanged.
 *
 * If a future method mutates a stored record in place, that invariant breaks for
 * both this shallow snapshot *and* any reference-sharing reader — the fix is to
 * keep replacing whole records, not to reintroduce a blanket deep clone.
 */
function captureSnapshot(state: MemoryState): MemorySnapshot {
  const snapshot: MemorySnapshot = new Map();
  for (const { key, kind } of MEMORY_SNAPSHOT_COLLECTIONS) {
    const value = state[key];
    snapshot.set(
      key,
      kind === "map"
        ? new Map(value as Map<unknown, unknown>)
        : [...(value as readonly unknown[])],
    );
  }
  return snapshot;
}

function restoreSnapshot(state: MemoryState, snapshot: MemorySnapshot): void {
  for (const { key, kind } of MEMORY_SNAPSHOT_COLLECTIONS) {
    const saved = snapshot.get(key);
    if (kind === "map") {
      replaceMapContents(
        state[key] as unknown as Map<unknown, unknown>,
        saved as Map<unknown, unknown>,
      );
    } else {
      replaceArrayContents(
        state[key] as unknown as unknown[],
        saved as unknown[],
      );
    }
  }
}

export function createTransactionMethods(
  state: MemoryState,
  getScope: () => StoreTransaction,
): MemoryStoreMethods {
  // Serialize withTransaction calls so two concurrent transactions snapshot /
  // restore against a stable state rather than interleaving on shared Maps.
  // Because a single in-flight snapshot covers the whole store, a concurrent
  // non-withTransaction write made while a transaction's callback is mid-flight
  // is captured by that snapshot and rolled back with it. Nesting would queue
  // the inner call behind the outer one on this chain and deadlock, so it is
  // rejected synchronously via the AsyncLocalStorage nesting guard.
  let chain: Promise<unknown> = Promise.resolve();
  const nesting = createTxNestingGuard();

  return {
    async withTransaction<T>(
      fn: (tx: StoreTransaction) => Promise<T>,
    ): Promise<T> {
      // Synchronous nesting guard — checked at CALL time (before chaining), so a
      // nested call rejects instead of deadlocking behind the outer transaction.
      if (nesting.isNested()) {
        throw nestedWithTransactionError(
          "MemoryStore",
          "memory",
          SERIALIZED_NESTING_REASON,
        );
      }
      const task = chain.then(() =>
        nesting.runScoped(async () => {
          const snap = captureSnapshot(state);
          try {
            // Resolve on success = commit (discard snapshot).
            return await fn(getScope());
          } catch (err) {
            restoreSnapshot(state, snap);
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
