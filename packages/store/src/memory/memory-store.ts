/**
 * In-memory DataStore implementation.
 * Used for testing and ephemeral sessions.
 */

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
    ...createVectorMethods(state),
  };

  return {
    ...data,
    ...createTransactionMethods(
      state,
      () => data as unknown as StoreTransaction,
    ),

    async close() {
      // No-op for in-memory store.
    },
  } as MemoryStore;
}
