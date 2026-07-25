/**
 * Reusable contract tests for any DataStore implementation.
 * Each backend (Memory, SQLite, PG) runs this same suite.
 */

import { describe, beforeEach, afterEach } from "vitest";
import type { DataStore } from "../types.js";
import { resetTestIds } from "./test-fixtures.js";
import { registerCoreStoreSuites } from "./suites/core-suites.js";
import { registerIntegrityStoreSuites } from "./suites/integrity-suites.js";
import { registerPersistenceStoreSuites } from "./suites/persistence-suites.js";
import { registerLifecycleStoreSuites } from "./suites/lifecycle-suites.js";
import { registerExportStoreSuites } from "./suites/export-suites.js";
import { registerPluginDataStoreSuite } from "./suites/plugin-data-suite.js";
import { registerRuntimeRecordStoreSuites } from "./suites/runtime-record-suites.js";
import { registerPaginationStoreSuites } from "./suites/pagination-suites.js";

// ── Contract test suite ─────────────────────────────────────────

export function runStoreContractTests(
  name: string,
  createStore: () => DataStore | Promise<DataStore>,
): void {
  describe(`DataStore Contract: ${name}`, () => {
    let store: DataStore;
    const getStore = () => store;

    beforeEach(async () => {
      resetTestIds();
      store = await createStore();
    });

    // Close the store after each test so backends that hold connection
    // pools (PG) don't pile up sockets across the contract run. Memory /
    // IDB / SQLite stores either ignore close() or release in-process
    // resources — all safe no-ops.
    afterEach(async () => {
      try {
        await store.close?.();
      } catch {
        // Swallow — close errors must not mask the actual test failure.
      }
    });

    registerCoreStoreSuites(getStore);
    registerPluginDataStoreSuite(getStore);
    registerRuntimeRecordStoreSuites(getStore);
    registerPaginationStoreSuites(getStore);
    registerPersistenceStoreSuites(getStore);
    registerIntegrityStoreSuites(getStore);
    registerLifecycleStoreSuites(getStore);
    registerExportStoreSuites(getStore);
  });
}
