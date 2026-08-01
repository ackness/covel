/**
 * inventory plugin tests.
 *
 * Covers:
 *
 * 1. Local tool `update-inventory` (L2): add stacking, remove-to-zero
 *    tombstones, tolerant removes of missing items, equip/unequip toggling,
 *    set field updates, the 8-change batch cap, same-turn pending-proposal
 *    overlay, and the per-turn message summary.
 * 2. Plugin manifest: agent runtime shape, narrative-engine gate, injects,
 *    dataSchemas, and UI declarations.
 *
 * Integration-level coverage (real LLM calling the tool chain) lives in
 * `scripts/e2e-plugin-verify.ts`, not here.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import path from "node:path";
import {
  discoverPlugins,
  loadPluginManifest,
  loadRuntime,
} from "@covel/plugin-loader";
import { getPendingProposals, tool, z, shortIdBatch } from "@covel/tools";
import createUpdateInventory from "../tools/update-inventory.js";

// In-memory mock store for plugin-data operations
function createMockPluginDataStore() {
  /** @type {Map<string, unknown>} */
  const data = new Map();
  const makeKey = (sid, pid, ns, k) => `${sid}:${pid}:${ns}:${k}`;

  return {
    data,
    async setPluginData(record) {
      data.set(
        makeKey(
          record.sessionId,
          record.pluginId,
          record.namespace,
          record.key,
        ),
        {
          namespace: record.namespace,
          key: record.key,
          value: record.value,
          updatedAt: record.updatedAt,
        },
      );
    },
    async setPluginDataBatch(records) {
      for (const r of records) await this.setPluginData(r);
    },
    async getPluginData(sessionId, pluginId, namespace, key) {
      return data.get(makeKey(sessionId, pluginId, namespace, key)) ?? null;
    },
    async listPluginData(sessionId, pluginId, namespace) {
      const results = [];
      for (const [k, v] of data) {
        if (
          k.startsWith(`${sessionId}:${pluginId}:`) &&
          (!namespace || k.startsWith(`${sessionId}:${pluginId}:${namespace}:`))
        ) {
          results.push(v);
        }
      }
      return results;
    },
  };
}

async function applyPendingPluginData(result, store) {
  for (const proposal of getPendingProposals(result)) {
    if (proposal.type === "plugin.data") {
      await store.setPluginData({
        id: proposal.id,
        sessionId: proposal.sessionId,
        pluginId: proposal.source.pluginId,
        namespace: proposal.payload.namespace,
        key: proposal.payload.key,
        value: proposal.payload.value,
        createdAt: proposal.timestamp,
        updatedAt: proposal.timestamp,
      });
      continue;
    }

    if (proposal.type === "plugin.data.batch") {
      await store.setPluginDataBatch(
        proposal.payload.items.map((item, index) => ({
          id: `${proposal.id}:${index}`,
          sessionId: proposal.sessionId,
          pluginId: proposal.source.pluginId,
          namespace: item.namespace,
          key: item.key,
          value: item.value,
          createdAt: proposal.timestamp,
          updatedAt: proposal.timestamp,
        })),
      );
    }
  }
}

async function executeAndCommit(toolModule, params, context, store) {
  const result = await toolModule.execute(params, context);
  await applyPendingPluginData(result, store);
  return result;
}

const PLUGINS_DIR = path.resolve(import.meta.dirname, "../..");

// ── Tool unit tests ──────────────────────────────────────────────

describe("update-inventory", () => {
  const ctx = {
    sessionId: "sess-1",
    turnId: "turn-1",
    pluginId: "inventory",
    runtimeId: "inventory",
  };
  let mockStore;
  let updateInventoryTool;

  beforeEach(() => {
    mockStore = createMockPluginDataStore();
    updateInventoryTool = createUpdateInventory({
      tool,
      z,
      shortIdBatch,
      store: mockStore,
    });
  });

  it("creates a new item on add and writes the per-turn message summary", async () => {
    // Arrange / Act
    const result = await executeAndCommit(
      updateInventoryTool,
      {
        changes: [
          {
            op: "add",
            name: "Iron Sword",
            quantity: 1,
            description: "A plain but sturdy blade.",
            tags: ["weapon"],
          },
        ],
      },
      ctx,
      mockStore,
    );

    // Assert — result + persisted item
    expect(result.applied).toBe(1);
    expect(result.results[0]).toMatchObject({
      op: "add",
      status: "created",
      itemId: "item-iron-sword",
      quantity: 1,
    });
    const stored = await mockStore.getPluginData(
      "sess-1",
      "inventory",
      "items",
      "item-iron-sword",
    );
    expect(stored.value).toMatchObject({
      id: "item-iron-sword",
      name: "Iron Sword",
      quantity: 1,
      tags: ["weapon"],
      equipped: false,
    });

    // Assert — message summary keyed by turnId
    const message = await mockStore.getPluginData(
      "sess-1",
      "inventory",
      "message",
      "turn-1",
    );
    expect(message.value.turnId).toBe("turn-1");
    expect(message.value.changes).toHaveLength(1);
    expect(message.value.changes[0]).toMatchObject({
      op: "add",
      text: "+ Iron Sword ×1",
      color: "green",
    });
  });

  it("stacks quantity onto an existing item matched by name (case-insensitive)", async () => {
    // Arrange
    await executeAndCommit(
      updateInventoryTool,
      { changes: [{ op: "add", name: "Torch", quantity: 2 }] },
      ctx,
      mockStore,
    );

    // Act
    const result = await executeAndCommit(
      updateInventoryTool,
      { changes: [{ op: "add", name: "torch", quantity: 3 }] },
      { ...ctx, turnId: "turn-2" },
      mockStore,
    );

    // Assert — same id, stacked quantity, no duplicate row
    expect(result.results[0]).toMatchObject({
      status: "updated",
      itemId: "item-torch",
      quantity: 5,
    });
    const rows = await mockStore.listPluginData("sess-1", "inventory", "items");
    expect(rows).toHaveLength(1);
    expect(rows[0].value.quantity).toBe(5);
  });

  it("decrements quantity on remove and defaults the amount to 1", async () => {
    // Arrange
    await executeAndCommit(
      updateInventoryTool,
      { changes: [{ op: "add", name: "Arrow", quantity: 5 }] },
      ctx,
      mockStore,
    );

    // Act
    const result = await executeAndCommit(
      updateInventoryTool,
      { changes: [{ op: "remove", name: "Arrow" }] },
      { ...ctx, turnId: "turn-2" },
      mockStore,
    );

    // Assert
    expect(result.results[0]).toMatchObject({ status: "updated", quantity: 4 });
    const stored = await mockStore.getPluginData(
      "sess-1",
      "inventory",
      "items",
      "item-arrow",
    );
    expect(stored.value.quantity).toBe(4);
    expect(stored.value.removed).toBeUndefined();
  });

  it("tombstones an item when remove drains it to zero", async () => {
    // Arrange
    await executeAndCommit(
      updateInventoryTool,
      { changes: [{ op: "add", name: "Torch", quantity: 2 }] },
      ctx,
      mockStore,
    );

    // Act
    const result = await executeAndCommit(
      updateInventoryTool,
      { changes: [{ op: "remove", name: "Torch", quantity: 2 }] },
      { ...ctx, turnId: "turn-2" },
      mockStore,
    );

    // Assert — tombstone, hidden from the bag but keeping the stable id
    expect(result.results[0]).toMatchObject({
      status: "removed",
      itemId: "item-torch",
    });
    const stored = await mockStore.getPluginData(
      "sess-1",
      "inventory",
      "items",
      "item-torch",
    );
    expect(stored.value).toMatchObject({
      quantity: 0,
      removed: true,
      equipped: false,
    });
    const message = await mockStore.getPluginData(
      "sess-1",
      "inventory",
      "message",
      "turn-2",
    );
    expect(message.value.changes[0].text).toBe("− Torch ×2");
  });

  it("revives a tombstoned item under the same id when re-acquired", async () => {
    // Arrange — add then fully remove
    await executeAndCommit(
      updateInventoryTool,
      { changes: [{ op: "add", name: "Torch" }] },
      ctx,
      mockStore,
    );
    await executeAndCommit(
      updateInventoryTool,
      { changes: [{ op: "remove", name: "Torch" }] },
      { ...ctx, turnId: "turn-2" },
      mockStore,
    );

    // Act
    const result = await executeAndCommit(
      updateInventoryTool,
      { changes: [{ op: "add", name: "Torch", quantity: 3 }] },
      { ...ctx, turnId: "turn-3" },
      mockStore,
    );

    // Assert — same row, fresh quantity, tombstone cleared
    expect(result.results[0]).toMatchObject({
      status: "created",
      itemId: "item-torch",
      quantity: 3,
    });
    const rows = await mockStore.listPluginData("sess-1", "inventory", "items");
    expect(rows).toHaveLength(1);
    expect(rows[0].value.removed).toBeUndefined();
    expect(rows[0].value.quantity).toBe(3);
  });

  it("skips removing an item that is not in the bag without failing the batch", async () => {
    // Arrange
    await executeAndCommit(
      updateInventoryTool,
      { changes: [{ op: "add", name: "Iron Sword" }] },
      ctx,
      mockStore,
    );

    // Act — one valid remove, one remove of a missing item
    const result = await executeAndCommit(
      updateInventoryTool,
      {
        changes: [
          { op: "remove", name: "Ghost Dagger" },
          { op: "remove", name: "Iron Sword" },
        ],
      },
      { ...ctx, turnId: "turn-2" },
      mockStore,
    );

    // Assert — missing item is a noted skip, the valid change still applies
    expect(result.skipped).toBe(1);
    expect(result.applied).toBe(1);
    expect(result.results[0]).toMatchObject({
      op: "remove",
      name: "Ghost Dagger",
      status: "skipped",
    });
    expect(result.results[0].note).toContain("not in inventory");
    // The skipped remove contributes no message entry
    const message = await mockStore.getPluginData(
      "sess-1",
      "inventory",
      "message",
      "turn-2",
    );
    expect(message.value.changes).toHaveLength(1);
    expect(message.value.changes[0].text).toBe("− Iron Sword ×1");
  });

  it("toggles equipped state via equip and unequip", async () => {
    // Arrange
    await executeAndCommit(
      updateInventoryTool,
      { changes: [{ op: "add", name: "Iron Sword" }] },
      ctx,
      mockStore,
    );

    // Act — equip
    await executeAndCommit(
      updateInventoryTool,
      { changes: [{ op: "equip", name: "Iron Sword" }] },
      { ...ctx, turnId: "turn-2" },
      mockStore,
    );
    let stored = await mockStore.getPluginData(
      "sess-1",
      "inventory",
      "items",
      "item-iron-sword",
    );
    expect(stored.value.equipped).toBe(true);

    // Act — equip again is a noted no-op
    const noop = await executeAndCommit(
      updateInventoryTool,
      { changes: [{ op: "equip", name: "Iron Sword" }] },
      { ...ctx, turnId: "turn-3" },
      mockStore,
    );
    expect(noop.results[0]).toMatchObject({
      status: "skipped",
      note: "already equipped",
    });

    // Act — unequip
    await executeAndCommit(
      updateInventoryTool,
      { changes: [{ op: "unequip", name: "Iron Sword" }] },
      { ...ctx, turnId: "turn-4" },
      mockStore,
    );
    stored = await mockStore.getPluginData(
      "sess-1",
      "inventory",
      "items",
      "item-iron-sword",
    );
    expect(stored.value.equipped).toBe(false);
  });

  it("skips equip for an item that is not in the bag", async () => {
    // Act
    const result = await executeAndCommit(
      updateInventoryTool,
      { changes: [{ op: "equip", name: "Phantom Shield" }] },
      ctx,
      mockStore,
    );

    // Assert — nothing persisted, no message
    expect(result.applied).toBe(0);
    expect(result.results[0]).toMatchObject({ status: "skipped" });
    const rows = await mockStore.listPluginData("sess-1", "inventory");
    expect(rows).toHaveLength(0);
  });

  it("updates only the provided fields on set", async () => {
    // Arrange
    await executeAndCommit(
      updateInventoryTool,
      {
        changes: [
          {
            op: "add",
            name: "Gold Coin",
            quantity: 10,
            description: "Shiny.",
            tags: ["currency"],
          },
        ],
      },
      ctx,
      mockStore,
    );

    // Act — correct the quantity estimate, leave description/tags alone
    await executeAndCommit(
      updateInventoryTool,
      { changes: [{ op: "set", name: "Gold Coin", quantity: 50 }] },
      { ...ctx, turnId: "turn-2" },
      mockStore,
    );

    // Assert
    const stored = await mockStore.getPluginData(
      "sess-1",
      "inventory",
      "items",
      "item-gold-coin",
    );
    expect(stored.value.quantity).toBe(50);
    expect(stored.value.description).toBe("Shiny.");
    expect(stored.value.tags).toEqual(["currency"]);
  });

  it("rejects a batch with more than 8 changes", async () => {
    // Arrange — 9 changes
    const changes = Array.from({ length: 9 }, (_, i) => ({
      op: "add",
      name: `Item ${i}`,
    }));

    // Act / Assert — zod validation fails before execute runs
    await expect(updateInventoryTool.execute({ changes }, ctx)).rejects.toThrow(
      /validation/i,
    );
    const rows = await mockStore.listPluginData("sess-1", "inventory");
    expect(rows).toHaveLength(0);
  });

  it("sees same-turn pending writes so a second call can equip a just-added item", async () => {
    // Arrange — first call adds the item but nothing committed yet
    const first = await updateInventoryTool.execute(
      { changes: [{ op: "add", name: "Iron Sword" }] },
      ctx,
    );

    // Act — second call in the same turn equips it via pending overlay
    const second = await updateInventoryTool.execute(
      { changes: [{ op: "equip", name: "Iron Sword" }] },
      { ...ctx, pendingProposals: getPendingProposals(first) },
    );

    // Assert — equip applied, and the merged message keeps both entries
    expect(second.results[0]).toMatchObject({
      status: "updated",
      itemId: "item-iron-sword",
    });
    await applyPendingPluginData(first, mockStore);
    await applyPendingPluginData(second, mockStore);
    const stored = await mockStore.getPluginData(
      "sess-1",
      "inventory",
      "items",
      "item-iron-sword",
    );
    expect(stored.value.equipped).toBe(true);
    const message = await mockStore.getPluginData(
      "sess-1",
      "inventory",
      "message",
      "turn-1",
    );
    expect(message.value.changes.map((c) => c.op)).toEqual(["add", "equip"]);
  });
});

// ── Plugin manifest tests ────────────────────────────────────────

describe("inventory plugin manifest", () => {
  let manifest;
  let loaded;

  beforeAll(async () => {
    const discoveries = await discoverPlugins(PLUGINS_DIR);
    const discovery = discoveries.find((d) => d.id === "inventory");
    const manifests = await loadPluginManifest(discovery);
    manifest = manifests[0].manifest;
    loaded = await loadRuntime(discovery, manifest.name);
  });

  it("is a non-core post-turn agent runtime gated on the narrative engine", () => {
    expect(manifest.pluginType).toBe("plugin");
    expect(manifest.name).toBe("inventory");
    expect(manifest.stage).toBe("post-turn");
    expect(manifest.trigger?.type).toBe("auto");
    expect(manifest.needs).toEqual([{ capability: "narrative-engine" }]);
    // Agent runtime — no `runtimeType` field means default 'agent'
    expect(manifest.runtimeType).toBeUndefined();
    expect(manifest.handler).toBeUndefined();
  });

  it("declares both narrative-engine injects and the plugin-data inject", () => {
    const injects = manifest.input?.inject ?? [];
    expect(injects).toHaveLength(3);

    for (const engine of ["narrator", "chat-mode-narrator"]) {
      expect(injects).toContainEqual({
        kind: "runtime",
        from: engine,
        field: "narrativeOutput",
        as: "<narrator-output>",
      });
    }

    expect(injects).toContainEqual(
      expect.objectContaining({
        kind: "plugin-data",
        namespace: "items",
        as: "<existing-inventory>",
        format: "summary",
        maxEntries: 80,
      }),
    );
  });

  it("declares the update-inventory plugin tool", () => {
    expect(manifest.tools?.plugin).toEqual(["update-inventory"]);
  });

  it("accepts world data into the items namespace", () => {
    const schema = manifest.dataSchemas?.items;
    expect(schema).toBeDefined();
    expect(schema.schemaVersion).toBe(1);
    expect(schema.acceptsWorldData).toBe(true);
    expect(schema.schema).toBe("./schemas/items.schema.json");
  });

  it("declares the right panel and message block UI specs", () => {
    expect(manifest.ui?.right).toContain("./ui/inventory-panel.json");
    expect(manifest.ui?.message).toContain("./ui/inventory-message.json");
  });

  it("loads UI spec JSON with panel metadata", () => {
    expect(loaded.uiSpecs?.right).toHaveLength(1);
    expect(loaded.uiSpecs?.right?.[0].id).toBe("inventory");
    expect(loaded.uiSpecs?.right?.[0].icon).toBe("backpack");
    expect(loaded.uiSpecs?.message).toHaveLength(1);
    expect(loaded.uiSpecs?.message?.[0].id).toBe("inventory-message");
  });

  it("loads PLUGIN.md body as the LLM prompt template", () => {
    expect(loaded.promptTemplate).toContain("<existing-inventory>");
    expect(loaded.promptTemplate).toContain("update-inventory");
  });
});
