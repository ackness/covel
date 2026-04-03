import "fake-indexeddb/auto";
import { IdbStore } from "../src/indexeddb/idb-store.js";
import { runDataStoreContractTests } from "./store-contract.js";

// Each test gets a unique DB name to avoid cross-test interference.
let dbCounter = 0;

runDataStoreContractTests("IdbStore", async () => {
  const store = new IdbStore({ dbName: `test-${++dbCounter}` });
  return {
    store,
    cleanup: async () => {
      await store.clear();
    },
  };
});
