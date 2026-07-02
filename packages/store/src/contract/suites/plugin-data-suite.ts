import { beforeEach, describe, expect, it } from "vitest";
import type {
  CharacterRecord,
  DataStore,
  StateEntryRecord,
} from "../../types.js";
import {
  id,
  makeApproval,
  makeCharacter,
  makeEvent,
  makeInteractionRecord,
  makeLorebookEntry,
  makeMessage,
  makePlayerInput,
  makeRuntimeOutput,
  makeRuntimeResult,
  makeSession,
  makeSessionSummary,
  makeSnapshot,
  makeSnapshotPayload,
  makeStateChange,
  makeStateEntry,
  makeStateSchema,
  makeSuspension,
  makeToolCall,
  makeTraceEvent,
  makeTurnMessage,
  makeTurnResult,
  makeWorkingMemory,
  makeWorld,
  makeWorldDataImportLedger,
  ts,
} from "../test-fixtures.js";

export function registerPluginDataStoreSuite(getStore: () => DataStore): void {
  let store: DataStore;

  beforeEach(() => {
    store = getStore();
  });

  describe("PluginData", () => {
    it("should set and get plugin data", async () => {
      const record = {
        id: "pd-1",
        sessionId: "sess-1",
        pluginId: "world-init",
        namespace: "schema",
        key: "dimensions",
        value: { hp: { type: "number", max: 100 }, name: { type: "string" } },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await store.setPluginData(record);
      const result = await store.getPluginData(
        "sess-1",
        "world-init",
        "schema",
        "dimensions",
      );
      expect(result).not.toBeNull();
      expect(result!.key).toBe("dimensions");
      expect(result!.value).toEqual(record.value);
    });

    it("should preserve plugin data null values", async () => {
      const now = new Date().toISOString();
      await store.setPluginData({
        id: "pd-null",
        sessionId: "sess-null",
        pluginId: "p-null",
        namespace: "entries",
        key: "empty",
        value: null,
        createdAt: now,
        updatedAt: now,
      });

      const result = await store.getPluginData(
        "sess-null",
        "p-null",
        "entries",
        "empty",
      );
      expect(result).not.toBeNull();
      expect(result!.value).toBeNull();
    });

    it("should upsert on conflict (same session+plugin+namespace+key)", async () => {
      const record1 = {
        id: "pd-2",
        sessionId: "sess-1",
        pluginId: "test-plugin",
        namespace: "config",
        key: "setting-a",
        value: { enabled: true },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await store.setPluginData(record1);

      const record2 = {
        ...record1,
        id: "pd-2-updated",
        value: { enabled: false, extra: 42 },
        updatedAt: new Date().toISOString(),
      };
      await store.setPluginData(record2);

      const result = await store.getPluginData(
        "sess-1",
        "test-plugin",
        "config",
        "setting-a",
      );
      expect(result).not.toBeNull();
      expect(result!.value).toEqual({ enabled: false, extra: 42 });
    });

    it("should list plugin data by namespace", async () => {
      await store.setPluginData({
        id: "pd-3a",
        sessionId: "sess-2",
        pluginId: "p1",
        namespace: "entries",
        key: "a",
        value: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await store.setPluginData({
        id: "pd-3b",
        sessionId: "sess-2",
        pluginId: "p1",
        namespace: "entries",
        key: "b",
        value: 2,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await store.setPluginData({
        id: "pd-3c",
        sessionId: "sess-2",
        pluginId: "p1",
        namespace: "other",
        key: "c",
        value: 3,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const withNs = await store.listPluginData("sess-2", "p1", "entries");
      expect(withNs).toHaveLength(2);

      const allNs = await store.listPluginData("sess-2", "p1");
      expect(allNs).toHaveLength(3);
    });

    it("should delete plugin data", async () => {
      await store.setPluginData({
        id: "pd-4",
        sessionId: "sess-3",
        pluginId: "p2",
        namespace: "temp",
        key: "x",
        value: "delete-me",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await store.deletePluginData("sess-3", "p2", "temp", "x");
      const result = await store.getPluginData("sess-3", "p2", "temp", "x");
      expect(result).toBeNull();
    });

    it("should return null for unknown plugin data", async () => {
      const result = await store.getPluginData(
        "sess-x",
        "unknown",
        "ns",
        "key",
      );
      expect(result).toBeNull();
    });

    it("should batch set plugin data", async () => {
      const now = new Date().toISOString();
      await store.setPluginDataBatch([
        {
          id: "pd-b1",
          sessionId: "sess-batch",
          pluginId: "p1",
          namespace: "entries",
          key: "a",
          value: { x: 1 },
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "pd-b2",
          sessionId: "sess-batch",
          pluginId: "p1",
          namespace: "entries",
          key: "b",
          value: { x: 2 },
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "pd-b3",
          sessionId: "sess-batch",
          pluginId: "p1",
          namespace: "schema",
          key: "c",
          value: { x: 3 },
          createdAt: now,
          updatedAt: now,
        },
      ]);

      const entries = await store.listPluginData("sess-batch", "p1", "entries");
      expect(entries).toHaveLength(2);

      const all = await store.listPluginData("sess-batch", "p1");
      expect(all).toHaveLength(3);

      const single = await store.getPluginData(
        "sess-batch",
        "p1",
        "entries",
        "a",
      );
      expect(single).not.toBeNull();
      expect(single!.value).toEqual({ x: 1 });
    });

    it("should preserve plugin data null values in batch writes", async () => {
      const now = new Date().toISOString();
      await store.setPluginDataBatch([
        {
          id: "pd-bn1",
          sessionId: "sess-batch-null",
          pluginId: "p1",
          namespace: "entries",
          key: "a",
          value: null,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "pd-bn2",
          sessionId: "sess-batch-null",
          pluginId: "p1",
          namespace: "entries",
          key: "b",
          value: { ready: true },
          createdAt: now,
          updatedAt: now,
        },
      ]);

      const single = await store.getPluginData(
        "sess-batch-null",
        "p1",
        "entries",
        "a",
      );
      expect(single).not.toBeNull();
      expect(single!.value).toBeNull();
    });

    it("should batch upsert on conflict", async () => {
      const now = new Date().toISOString();
      await store.setPluginDataBatch([
        {
          id: "pd-u1",
          sessionId: "sess-upsert",
          pluginId: "p1",
          namespace: "ns",
          key: "k1",
          value: "old",
          createdAt: now,
          updatedAt: now,
        },
      ]);
      const later = new Date(Date.now() + 1000).toISOString();
      await store.setPluginDataBatch([
        {
          id: "pd-u2",
          sessionId: "sess-upsert",
          pluginId: "p1",
          namespace: "ns",
          key: "k1",
          value: "new",
          createdAt: later,
          updatedAt: later,
        },
      ]);
      const result = await store.getPluginData("sess-upsert", "p1", "ns", "k1");
      expect(result!.value).toBe("new");
    });

    it("should handle empty batch", async () => {
      await store.setPluginDataBatch([]);
      // No error thrown
    });

    it("should isolate data between sessions", async () => {
      await store.setPluginData({
        id: "pd-5a",
        sessionId: "sess-A",
        pluginId: "p1",
        namespace: "ns",
        key: "k",
        value: "session-A",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await store.setPluginData({
        id: "pd-5b",
        sessionId: "sess-B",
        pluginId: "p1",
        namespace: "ns",
        key: "k",
        value: "session-B",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const a = await store.getPluginData("sess-A", "p1", "ns", "k");
      const b = await store.getPluginData("sess-B", "p1", "ns", "k");
      expect(a!.value).toBe("session-A");
      expect(b!.value).toBe("session-B");
    });

    it("should isolate data between plugins in the same session", async () => {
      const now = new Date().toISOString();
      await store.setPluginData({
        id: "pd-iso-a",
        sessionId: "sess-X",
        pluginId: "plugin-a",
        namespace: "ns",
        key: "k",
        value: "from-a",
        createdAt: now,
        updatedAt: now,
      });
      await store.setPluginData({
        id: "pd-iso-b",
        sessionId: "sess-X",
        pluginId: "plugin-b",
        namespace: "ns",
        key: "k",
        value: "from-b",
        createdAt: now,
        updatedAt: now,
      });
      const a = await store.getPluginData("sess-X", "plugin-a", "ns", "k");
      const b = await store.getPluginData("sess-X", "plugin-b", "ns", "k");
      expect(a!.value).toBe("from-a");
      expect(b!.value).toBe("from-b");
    });

    // Audit 2026-04-20 finding 7.2 — snapshot payload builder relies on
    // listPluginDataSessionScope to pick up plugins that wrote plugin_data
    // without producing a runtime result.
    it("listPluginDataSessionScope returns all pluginIds and namespaces for a session", async () => {
      const now = new Date().toISOString();
      // Three plugins, multiple namespaces, some multi-key.
      await store.setPluginDataBatch([
        {
          id: "pd-scope-1a",
          sessionId: "sess-scope",
          pluginId: "plugin-a",
          namespace: "ns1",
          key: "k",
          value: 1,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "pd-scope-1b",
          sessionId: "sess-scope",
          pluginId: "plugin-a",
          namespace: "ns2",
          key: "k",
          value: 2,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "pd-scope-2",
          sessionId: "sess-scope",
          pluginId: "plugin-b",
          namespace: "ns1",
          key: "k",
          value: 3,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "pd-scope-3",
          sessionId: "sess-scope",
          pluginId: "plugin-c",
          namespace: "ns1",
          key: "k1",
          value: 4,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "pd-scope-3b",
          sessionId: "sess-scope",
          pluginId: "plugin-c",
          namespace: "ns1",
          key: "k2",
          value: 5,
          createdAt: now,
          updatedAt: now,
        },
      ]);

      // Parallel session — must NOT appear in our scope query.
      await store.setPluginData({
        id: "pd-scope-other",
        sessionId: "sess-other",
        pluginId: "plugin-a",
        namespace: "ns1",
        key: "k",
        value: 99,
        createdAt: now,
        updatedAt: now,
      });

      const rows = await store.listPluginDataSessionScope("sess-scope");
      expect(rows).toHaveLength(5);
      for (const r of rows) {
        expect(r.sessionId).toBe("sess-scope");
      }

      // All three pluginIds are represented.
      const pluginIds = new Set(rows.map((r) => r.pluginId));
      expect(pluginIds).toEqual(new Set(["plugin-a", "plugin-b", "plugin-c"]));

      // Both namespaces from plugin-a survived.
      const pluginA = rows.filter((r) => r.pluginId === "plugin-a");
      expect(new Set(pluginA.map((r) => r.namespace))).toEqual(
        new Set(["ns1", "ns2"]),
      );

      // Session isolation: cross-session row is not returned.
      const otherRows = await store.listPluginDataSessionScope("sess-other");
      expect(otherRows).toHaveLength(1);
      expect(otherRows[0]!.pluginId).toBe("plugin-a");
    });

    it("listPluginDataSessionScope returns an empty array for a session with no plugin_data", async () => {
      const rows = await store.listPluginDataSessionScope("sess-no-data");
      expect(rows).toEqual([]);
    });
  });
}
