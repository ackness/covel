import { runStoreContractTests } from '../src/contract/store-contract.js';
import { createMemoryStore } from '../src/memory/memory-store.js';

runStoreContractTests('MemoryStore', () => createMemoryStore());
