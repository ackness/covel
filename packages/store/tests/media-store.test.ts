import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMediaStoreContractTests } from '../src/contract/media-store-contract.js';
import { createMemoryMediaStore, createSqliteMediaStore } from '../src/media-store.js';

runMediaStoreContractTests('MemoryMediaStore', () => createMemoryMediaStore());

runMediaStoreContractTests('SqliteMediaStore', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'covel-media-store-test-'));
  return createSqliteMediaStore(path.join(tmpDir, 'test.db'), {
    mediaRoot: path.join(tmpDir, 'media'),
  });
});
