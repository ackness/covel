/**
 * In-memory DataStore implementation.
 * Used for testing and ephemeral sessions.
 */

import { createLifecycleMethods } from "./lifecycle-methods.js";
import { createExportMethods } from "./export-methods.js";
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
import { withStructuredCloneBoundary } from "./structured-clone-boundary.js";

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
    ...createExportMethods(state),
    ...createVectorMethods(state),
  };
  const isolatedData = withStructuredCloneBoundary(data);

  // One shared state means a transaction cannot isolate on its own: writes are
  // applied to the live collections before the callback settles. Queue every
  // root operation (reads included) behind an open transaction so callers can
  // never observe a value that is subsequently rolled back. The transaction
  // scope keeps the UNGATED methods, so reads/writes through `tx` run inline.
  const gate = createSerializedWriteGate();
  const gatedData = gate.gateWrites(
    isolatedData,
    new Set([...Object.keys(isolatedData), ...STORE_WRITE_METHODS]),
  );

  return {
    ...gatedData,
    ...createTransactionMethods(
      state,
      () => isolatedData as unknown as StoreTransaction,
      gate,
    ),

    async close() {
      // No-op for in-memory store.
    },
  } as MemoryStore;
}
