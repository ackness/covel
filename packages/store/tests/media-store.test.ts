import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { runMediaStoreContractTests } from '../src/contract/media-store-contract.js';
import { createIndexedDbMediaStore } from '../src/indexeddb/idb-media-store.js';
import {
  createMemoryMediaStore,
  createPgMediaStore,
  createS3MediaStore,
  createSqliteMediaStore,
  type S3CompatibleMediaClient,
  type S3CompatibleObject,
  type S3CompatibleObjectInfo,
} from '../src/media-store.js';

runMediaStoreContractTests('MemoryMediaStore', () => createMemoryMediaStore());

runMediaStoreContractTests('SqliteMediaStore', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'covel-media-store-test-'));
  return createSqliteMediaStore(path.join(tmpDir, 'test.db'), {
    mediaRoot: path.join(tmpDir, 'media'),
  });
});

class FakeS3Client implements S3CompatibleMediaClient {
  readonly objects = new Map<string, S3CompatibleObject>();

  async putObject(input: S3CompatibleObject): Promise<void> {
    this.objects.set(input.key, {
      key: input.key,
      bytes: new Uint8Array(input.bytes),
      mime: input.mime,
      ...(input.meta === undefined ? {} : { meta: input.meta }),
    });
  }

  async getObject(key: string): Promise<S3CompatibleObject | null> {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      key,
      bytes: new Uint8Array(object.bytes),
      mime: object.mime,
      ...(object.meta === undefined ? {} : { meta: object.meta }),
    };
  }

  async headObject(key: string): Promise<S3CompatibleObjectInfo | null> {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      key,
      size: object.bytes.byteLength,
      mime: object.mime,
      ...(object.meta === undefined ? {} : { meta: object.meta }),
    };
  }

  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async createSignedGetUrl(key: string): Promise<string> {
    return `https://media.example.test/${key}?signature=test`;
  }
}

runMediaStoreContractTests('S3MediaStore', () =>
  createS3MediaStore(new FakeS3Client(), {
    bucket: 'covel-test',
    keyPrefix: 'media',
  }),
);

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://covel:covel_dev@localhost:5432/covel';

let pgAvailable = false;
try {
  const { default: postgres } = await import('postgres');
  const client = postgres(DATABASE_URL, { connect_timeout: 3 });
  await client`SELECT 1`;
  await client.end();
  pgAvailable = true;
} catch {
  console.warn('PostgreSQL not available, skipping PgMediaStore tests');
}

if (pgAvailable) {
  runMediaStoreContractTests('PgMediaStore', () =>
    createPgMediaStore(DATABASE_URL, { freshSchema: true }),
  );
} else {
  describe('PgMediaStore (skipped)', () => {
    it('skipped — PostgreSQL not available', () => {
      expect(true).toBe(true);
    });
  });
}

let idbCounter = 0;
runMediaStoreContractTests('IndexedDbMediaStore', async () => {
  idbCounter += 1;
  return createIndexedDbMediaStore({ dbName: `covel-media-store-test-${idbCounter}` });
});
