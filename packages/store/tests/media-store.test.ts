import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { runMediaStoreContractTests } from "../src/contract/media-store-contract.js";
import { createIndexedDbMediaStore } from "../src/indexeddb/idb-media-store.js";
import {
  createMemoryMediaStore,
  createPgMediaStore,
  createSqliteMediaStore,
} from "../src/media-store.js";

runMediaStoreContractTests("MemoryMediaStore", () => createMemoryMediaStore());

runMediaStoreContractTests("SqliteMediaStore", () => {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "covel-media-store-test-"),
  );
  return createSqliteMediaStore(path.join(tmpDir, "test.db"), {
    mediaRoot: path.join(tmpDir, "media"),
  });
});

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://covel:covel_dev@localhost:5432/covel";

let pgAvailable = false;
try {
  const { default: postgres } = await import("postgres");
  const client = postgres(DATABASE_URL, { connect_timeout: 3 });
  await client`SELECT 1`;
  await client.end();
  pgAvailable = true;
} catch {
  console.warn("PostgreSQL not available, skipping PgMediaStore tests");
}

if (pgAvailable) {
  const { createIsolatedPgUrl } = await import("./pg-test-db.js");
  // Own database so this file never races concurrent PG test files on schema DDL.
  const isolatedUrl = await createIsolatedPgUrl(
    DATABASE_URL,
    "covel_test_media",
  );

  runMediaStoreContractTests("PgMediaStore", () =>
    createPgMediaStore(isolatedUrl, { freshSchema: true }),
  );
} else {
  describe("PgMediaStore (skipped)", () => {
    it("skipped — PostgreSQL not available", () => {
      expect(true).toBe(true);
    });
  });
}

let idbCounter = 0;
runMediaStoreContractTests("IndexedDbMediaStore", async () => {
  idbCounter += 1;
  return createIndexedDbMediaStore({
    dbName: `covel-media-store-test-${idbCounter}`,
  });
});
