import 'fake-indexeddb/auto'; // Must be first import — polyfills global indexedDB
import { runStoreContractTests } from '../src/contract/store-contract.js';
import { createIdbStore } from '../src/indexeddb/idb-store.js';

let dbCounter = 0;

runStoreContractTests('IdbStore', async () => {
  // Each test gets a unique DB name to avoid state leakage
  dbCounter++;
  return createIdbStore(`test-db-${dbCounter}`);
});
