/**
 * In-memory DataStore implementation.
 * Used for testing and ephemeral sessions.
 */

import { createLifecycleMethods } from "./lifecycle-methods.js";
import { createMemoryState } from "./memory-state.js";
import { createPluginDataMethods } from "./plugin-data-methods.js";
import { createRuntimeMethods } from "./runtime-methods.js";
import { createSessionMethods } from "./session-methods.js";
import {
  createSnapshotMethods,
  createSuspensionMethods,
} from "./snapshot-methods.js";
import { createTransactionMethods } from "./transaction-methods.js";
import { createVectorMethods } from "./vector-methods.js";
import {
  createLorebookMethods,
  createWorkingMemoryMethods,
  createWorldDataImportLedgerMethods,
} from "./working-memory-methods.js";
import { createWorldMethods } from "./world-methods.js";
import type { MemoryStore } from "./memory-types.js";
import type { StoreTransaction } from "../types.js";
import { createSerializedWriteGate } from "../serialized-write-gate.js";
import { STORE_WRITE_METHODS } from "../store-write-methods.js";

export function createMemoryStore(): MemoryStore {
  const state = createMemoryState();

  // Data methods first; the transaction scope is the same store (single shared
  // state), so `withTransaction` hands `fn` these data methods.
  const data = {
    ...createSessionMethods(state),
    ...createRuntimeMethods(state),
    ...createPluginDataMethods(state),
    ...createWorldMethods(state),
    ...createWorkingMemoryMethods(state),
    ...createWorldDataImportLedgerMethods(state),
    ...createLorebookMethods(state),
    ...createSuspensionMethods(state),
    ...createSnapshotMethods(state),
    ...createLifecycleMethods(state),
    ...createVectorMethods(state),
  };

  // One shared state means a transaction cannot isolate: a write issued
  // elsewhere while a transaction is open can be captured by its snapshot and
  // rolled back with it. The gate puts transactions and outside-of-transaction
  // writes on one queue. The transaction scope keeps the UNGATED methods —
  // writes inside the callback belong to that transaction.
  const gate = createSerializedWriteGate();
  const gatedData = gate.gateWrites(data, STORE_WRITE_METHODS);

  return {
    ...gatedData,
    ...createTransactionMethods(
      state,
      () => data as unknown as StoreTransaction,
      gate,
    ),

    async close() {
      // No-op for in-memory store.
    },
  } as MemoryStore;
}
