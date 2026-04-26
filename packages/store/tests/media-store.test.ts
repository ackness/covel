import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import 'fake-indexeddb/auto';
import { runMediaStoreContractTests } from '../src/contract/media-store-contract.js';
import { createIndexedDbMediaStore } from '../src/indexeddb/idb-media-store.js';
import { createMemoryMediaStore, createSqliteMediaStore } from '../src/media-store.js';

runMediaStoreContractTests('MemoryMediaStore', () => createMemoryMediaStore());

runMediaStoreContractTests('SqliteMediaStore', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'covel-media-store-test-'));
  return createSqliteMediaStore(path.join(tmpDir, 'test.db'), {
    mediaRoot: path.join(tmpDir, 'media'),
  });
});

let idbCounter = 0;
runMediaStoreContractTests('IndexedDbMediaStore', async () => {
  idbCounter += 1;
  return createIndexedDbMediaStore({ dbName: `covel-media-store-test-${idbCounter}` });
});
