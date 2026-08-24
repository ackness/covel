import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import "fake-indexeddb/auto";
import { afterAll, describe, expect, it } from "vitest";
import { runMediaStoreContractTests } from "../src/contract/media-store-contract.js";
import { createIndexedDbMediaStore } from "../src/indexeddb/idb-media-store.js";
import {
  createMemoryMediaStore,
  createPgMediaStore,
  createSqliteMediaStore,
} from "../src/media-store.js";
import {
  acquireSqliteConnection,
  releaseSqliteConnection,
} from "../src/sqlite/shared-connection.js";

runMediaStoreContractTests("MemoryMediaStore", () => createMemoryMediaStore());

runMediaStoreContractTests("SqliteMediaStore", () => {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "covel-media-store-test-"),
  );
  return createSqliteMediaStore(path.join(tmpDir, "test.db"), {
    mediaRoot: path.join(tmpDir, "media"),
  });
});

describe("SqliteMediaStore transaction boundaries", () => {
  it("removes refs and the asset inside one SQLite transaction", async () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "covel-media-delete-tx-"),
    );
    const dbPath = path.join(tmpDir, "test.db");
    const store = createSqliteMediaStore(dbPath, {
      mediaRoot: path.join(tmpDir, "media"),
    });
    const sqlite = acquireSqliteConnection(dbPath);
    let deleteObservedInTransaction = false;
    sqlite.function("covel_observe_media_delete_tx", () => {
      deleteObservedInTransaction = sqlite.inTransaction;
      return null;
    });
    sqlite.exec(`
      CREATE TEMP TRIGGER observe_media_delete_tx
      AFTER DELETE ON media_refs
      BEGIN
        SELECT covel_observe_media_delete_tx();
      END
    `);

    try {
      const ref = await store.put(new Uint8Array([1, 2, 3]), "image/png");
      await store.addRef(ref.id, "sess-delete", "plugin-delete");
      await store.delete(ref.id);

      expect(deleteObservedInTransaction).toBe(true);
      expect(await store.exists(ref.id)).toBe(false);
      expect(await store.listRefs()).toEqual([]);
    } finally {
      sqlite.exec("DROP TRIGGER IF EXISTS observe_media_delete_tx");
      releaseSqliteConnection(sqlite);
      await store.close?.();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://covel:covel_dev@localhost:5432/covel";
const REQUIRE_PG = process.env.COVEL_REQUIRE_PG_TESTS === "1";

let pgAvailable = false;
try {
  const { default: postgres } = await import("postgres");
  const client = postgres(DATABASE_URL, { connect_timeout: 3 });
  await client`SELECT 1`;
  await client.end();
  pgAvailable = true;
} catch (error) {
  if (REQUIRE_PG) {
    throw new Error("PostgreSQL is required for PgMediaStore tests", {
      cause: error,
    });
  }
  console.warn("PostgreSQL not available, skipping PgMediaStore tests");
}

if (pgAvailable) {
  const { createIsolatedPgDatabase } = await import("./pg-test-db.js");
  // Own database so this file never races concurrent PG test files on schema DDL.
  const isolated = await createIsolatedPgDatabase(
    DATABASE_URL,
    "covel_test_media",
  );
  afterAll(() => isolated.cleanup());

  runMediaStoreContractTests("PgMediaStore", () =>
    createPgMediaStore(isolated.url, { freshSchema: true }),
  );
  describe("PgMediaStore lifecycle", () => {
    it("exposes an idempotent close for its owned client", async () => {
      const store = await createPgMediaStore(isolated.url);
      expect(store.close).toEqual(expect.any(Function));
      await store.close?.();
      await store.close?.();
    });
  });
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
