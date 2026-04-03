import { MemoryStore } from "../src/memory/memory-store.js";
import { runDataStoreContractTests } from "./store-contract.js";

runDataStoreContractTests("MemoryStore", async () => ({
  store: new MemoryStore(),
}));
