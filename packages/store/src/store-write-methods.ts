/**
 * The names of every mutating `DataStore` method.
 *
 * Derived from `WRITE_METHOD_TOUCHES` — the map MemoryStore already maintains
 * to decide which collections a transaction must snapshot — so there is one
 * list, not two that can drift. `tests/memory-transaction-rollback.test.ts`
 * pins every key there against a real store method.
 *
 * Consumed by the serialized write gate on single-connection backends to
 * decide which methods must queue behind an open transaction.
 */

import { WRITE_METHOD_TOUCHES } from "./memory/transaction-methods.js";

export const STORE_WRITE_METHODS: ReadonlySet<string> = new Set(
  Object.keys(WRITE_METHOD_TOUCHES),
);

/**
 * Mutators of the optional vector capability. Not part of `DataStore`, so they
 * are absent from `WRITE_METHOD_TOUCHES`, but on SQLite they share the store's
 * single connection and must queue on the same gate.
 */
export const VECTOR_WRITE_METHODS: ReadonlySet<string> = new Set([
  "upsertVector",
  "deleteVectors",
  "ensureVectorModel",
  "lockSessionEmbeddingModel",
]);

/**
 * Mutators of the SQLite mirror media store — same connection, same gate.
 */
export const MEDIA_WRITE_METHODS: ReadonlySet<string> = new Set([
  "put",
  "delete",
  "recordOwnership",
  "addRef",
  "removeRef",
]);
