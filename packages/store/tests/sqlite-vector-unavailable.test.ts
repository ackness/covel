import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeSession } from "../src/contract/test-fixtures.js";
import { createSqliteStore } from "../src/sqlite/sqlite-store.js";
import { openSqliteConnection } from "../src/sqlite/node-sqlite.js";
import { createSqliteVectorCapability } from "../src/sqlite/sqlite-vector.js";
import { supportsVector } from "../src/vector-store.js";

afterEach(() => vi.restoreAllMocks());

describe("SQLite deletion without sqlite-vec", () => {
  it("deletes indexed and unindexed sessions, then reclaims only orphan vectors on recovery", async () => {
    const dir = mkdtempSync(join(tmpdir(), "covel-vec-unavailable-"));
    const dbPath = join(dir, "covel.db");
    let store = createSqliteStore(dbPath);
    try {
      if (!supportsVector(store))
        throw new Error("sqlite-vec is required for setup");
      const models = [];
      for (const id of ["deleted", "retained"]) {
        await store.createSession(makeSession({ id, worldId: undefined }));
        const target = await store.ensureVectorModel({
          modelId: `test/${id}`,
          provider: "test",
          modelName: id,
          dim: 2,
        });
        models.push(target);
        await store.lockSessionEmbeddingModel(id, target);
        await store.upsertVector({
          sessionId: id,
          pluginId: "test",
          namespace: "memory",
          key: "one",
          embedding: new Float32Array([1, 0]),
        });
      }
      await store.createSession(
        makeSession({ id: "unindexed", worldId: undefined }),
      );
      for (const id of ["deleted", "unindexed", "retained"]) {
        await store.setPluginData({
          id: `data-${id}`,
          sessionId: id,
          pluginId: "test",
          namespace: "memory",
          key: "one",
          value: "saved",
          createdAt: "2026-10-14T00:00:00.000Z",
          updatedAt: "2026-10-14T00:00:00.000Z",
        });
      }
      await store.close();

      // This is a fresh connection, so no vec0 module is registered. Only the
      // extension loader fails; all SQL still runs against the real database.
      const load = vi
        .spyOn(DatabaseSync.prototype, "loadExtension")
        .mockImplementation(() => {
          throw new Error("extension binary unavailable");
        });
      vi.spyOn(console, "warn").mockImplementation(() => {});
      store = createSqliteStore(dbPath);
      expect(supportsVector(store)).toBe(false);
      for (const id of ["unindexed", "deleted"]) {
        await expect(store.deleteSession(id)).resolves.toBeUndefined();
        expect(await store.getSession(id)).toBeNull();
        expect(await store.listPluginData(id, "test", "memory")).toEqual([]);
      }
      expect(await store.getSession("retained")).not.toBeNull();
      await store.close();
      load.mockRestore();

      const db = openSqliteConnection(dbPath);
      try {
        expect(createSqliteVectorCapability(db)).not.toBeNull();
        for (const target of models) {
          const rows = db
            .prepare(`SELECT session_id FROM ${target.tableName}`)
            .all();
          expect(rows).toEqual(
            target.modelId === "test/deleted"
              ? []
              : [{ session_id: "retained" }],
          );
        }
      } finally {
        db.close();
      }
    } finally {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
