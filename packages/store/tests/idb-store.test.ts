import "fake-indexeddb/auto"; // Must be first import — polyfills global indexedDB
import { describe, expect, it } from "vitest";
import { runStoreContractTests } from "../src/contract/store-contract.js";
import { createIdbStore } from "../src/indexeddb/idb-store.js";
import { makeSnapshot } from "../src/contract/test-fixtures.js";
import {
  BROWSER_IDB_SCHEMA_VERSION,
  upgradeBrowserIdbSchema,
} from "../src/indexeddb/idb-schema.js";

let dbCounter = 0;

runStoreContractTests("IdbStore", async () => {
  // Each test gets a unique DB name to avoid state leakage
  dbCounter++;
  return createIdbStore(`test-db-${dbCounter}`);
});

describe("IdbStore snapshot cursor implementation", () => {
  it("uses an index cursor instead of materialising every snapshot with getAll", async () => {
    const store = await createIdbStore(`snapshot-cursor-${++dbCounter}`);
    for (let i = 0; i < 5; i++) {
      await store.saveSnapshot(
        makeSnapshot({
          id: `snap-${i}`,
          sessionId: "session-cursor",
          createdAt: `2026-01-01T00:00:0${i}.000Z`,
        }),
      );
    }

    const originalGetAll = IDBIndex.prototype.getAll;
    IDBIndex.prototype.getAll = function forbiddenGetAll() {
      throw new Error("listSnapshotsPage must not call IDBIndex.getAll");
    };
    try {
      const page = await store.listSnapshotsPage("session-cursor", {
        limit: 2,
      });
      expect(page.map((item) => item.id)).toEqual(["snap-3", "snap-4"]);
    } finally {
      IDBIndex.prototype.getAll = originalGetAll;
      await store.close();
    }
  });

  it("repairs metadata when a lightweight browser opener performed the upgrade", async () => {
    const dbName = `snapshot-migration-${++dbCounter}`;
    const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(dbName, 11);
      request.onupgradeneeded = () => {
        const snapshots = request.result.createObjectStore("state_snapshots", {
          keyPath: "id",
        });
        snapshots.createIndex("sessionId", "sessionId");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const record = makeSnapshot({
      id: "legacy-snapshot",
      sessionId: "legacy-session",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await new Promise<void>((resolve, reject) => {
      const tx = legacy.transaction("state_snapshots", "readwrite");
      tx.objectStore("state_snapshots").put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    legacy.close();

    const lightweight = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(dbName, BROWSER_IDB_SCHEMA_VERSION);
      request.onupgradeneeded = (event) => {
        upgradeBrowserIdbSchema(request.result, event.oldVersion);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    lightweight.close();

    const store = await createIdbStore(dbName);
    try {
      const page = await store.listSnapshotsPage("legacy-session", {
        limit: 1,
      });
      expect(page.map((item) => item.id)).toEqual(["legacy-snapshot"]);
    } finally {
      await store.close();
    }
  });
});
