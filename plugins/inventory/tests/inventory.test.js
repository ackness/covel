import {
  getToolContent,
  getPendingProposals,
} from "@covel/plugin-handlers-utils";
import { readFileSync as readContractFile } from "node:fs";
import {
  bindToolStore,
  createPluginTestStore,
  executeToolAndCommit as executeAndCommit,
  commitToolResults,
} from "@covel/plugin-test-utils";
/**
 * inventory plugin tests.
 *
 * Covers:
 *
 * 1. Ledger `update-inventory`: add stacking, remove-to-zero tombstones,
 *    tolerant removes of missing items, equip/unequip toggling, set field
 *    updates, the 8-change batch cap, same-turn pending-proposal overlay,
 *    and the per-turn message summary.
 * 2. WorldIR mapping, the ledger handler, and the vocabulary handler.
 * 3. Plugin manifest: function runtime shapes, WorldIR gate, dataSchemas,
 *    and UI declarations.
 *
 * Integration-level coverage (real extraction feeding the ledger) lives in
 * `scripts/e2e-plugin-verify.ts`, not here.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import path from "node:path";
import {
  discoverPlugins,
  loadPluginDefinition,
  loadPluginUi,
  loadRuntime,
} from "@covel/plugin-loader";

import updateInventory from "../lib/update-inventory.js";
import { inventoryChangesFromWorldIR } from "../lib/world-ir.js";
import ledger from "../runtimes/ledger/handler.js";
import vocabulary from "../runtimes/vocabulary/handler.js";

const PLUGINS_DIR = path.resolve(import.meta.dirname, "../..");

// ── Tool unit tests ──────────────────────────────────────────────

describe("update-inventory", () => {
  const ctx = {
    sessionId: "sess-1",
    turnId: "turn-1",
    pluginId: "inventory",
    runtimeId: "inventory/ledger",
  };
  let mockStore;
  let updateInventoryTool;

  beforeEach(async () => {
    mockStore = await createPluginTestStore(ctx);
    updateInventoryTool = bindToolStore(
      { execute: updateInventory },
      mockStore,
    );
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

    const itemId = getToolContent(result).results[0].itemId;
    expect(itemId).toMatch(/^item-iron-sword-[a-f0-9]{8}$/);

    // Assert — result + persisted item
    expect(getToolContent(result).applied).toBe(1);
    expect(getToolContent(result).results[0]).toMatchObject({
      op: "add",
      status: "created",
      itemId,
      quantity: 1,
    });
    const stored = await mockStore.getPluginData(
      "sess-1",
      "inventory",
      "items",
      itemId,
    );
    expect(stored.value).toMatchObject({
      id: itemId,
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
    const created = await executeAndCommit(
      updateInventoryTool,
      { changes: [{ op: "add", name: "Torch", quantity: 2 }] },
      ctx,
      mockStore,
    );
    const itemId = getToolContent(created).results[0].itemId;

    // Act
    const result = await executeAndCommit(
      updateInventoryTool,
      { changes: [{ op: "add", name: "torch", quantity: 3 }] },
      { ...ctx, turnId: "turn-2" },
      mockStore,
    );

    // Assert — same id, stacked quantity, no duplicate row
    expect(getToolContent(result).results[0]).toMatchObject({
      status: "updated",
      itemId,
      quantity: 5,
    });
    const rows = await mockStore.listPluginData("sess-1", "inventory", "items");
    expect(rows).toHaveLength(1);
    expect(rows[0].value.quantity).toBe(5);
  });

  it("decrements quantity on remove and defaults the amount to 1", async () => {
    // Arrange
    const created = await executeAndCommit(
      updateInventoryTool,
      { changes: [{ op: "add", name: "Arrow", quantity: 5 }] },
      ctx,
      mockStore,
    );
    const itemId = getToolContent(created).results[0].itemId;

    // Act
    const result = await executeAndCommit(
      updateInventoryTool,
      { changes: [{ op: "remove", name: "Arrow" }] },
      { ...ctx, turnId: "turn-2" },
      mockStore,
    );

    // Assert
    expect(getToolContent(result).results[0]).toMatchObject({
      status: "updated",
      quantity: 4,
    });
    const stored = await mockStore.getPluginData(
      "sess-1",
      "inventory",
      "items",
      itemId,
    );
    expect(stored.value.quantity).toBe(4);
    expect(stored.value.removed).toBeUndefined();
  });

  it("tombstones an item when remove drains it to zero", async () => {
    // Arrange
    const created = await executeAndCommit(
      updateInventoryTool,
      { changes: [{ op: "add", name: "Torch", quantity: 2 }] },
      ctx,
      mockStore,
    );
    const itemId = getToolContent(created).results[0].itemId;

    // Act
    const result = await executeAndCommit(
      updateInventoryTool,
      { changes: [{ op: "remove", name: "Torch", quantity: 2 }] },
      { ...ctx, turnId: "turn-2" },
      mockStore,
    );

    // Assert — tombstone, hidden from the bag but keeping the stable id
    expect(getToolContent(result).results[0]).toMatchObject({
      status: "removed",
      itemId,
    });
    const stored = await mockStore.getPluginData(
      "sess-1",
      "inventory",
      "items",
      itemId,
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
    const created = await executeAndCommit(
      updateInventoryTool,
      { changes: [{ op: "add", name: "Torch" }] },
      ctx,
      mockStore,
    );
    const itemId = getToolContent(created).results[0].itemId;
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
    expect(getToolContent(result).results[0]).toMatchObject({
      status: "created",
      itemId,
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
    expect(getToolContent(result).skipped).toBe(1);
    expect(getToolContent(result).applied).toBe(1);
    expect(getToolContent(result).results[0]).toMatchObject({
      op: "remove",
      name: "Ghost Dagger",
      status: "skipped",
    });
    expect(getToolContent(result).results[0].note).toContain(
      "not in inventory",
    );
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
    const created = await executeAndCommit(
      updateInventoryTool,
      { changes: [{ op: "add", name: "Iron Sword" }] },
      ctx,
      mockStore,
    );
    const itemId = getToolContent(created).results[0].itemId;

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
      itemId,
    );
    expect(stored.value.equipped).toBe(true);

    // Act — equip again is a noted no-op
    const noop = await executeAndCommit(
      updateInventoryTool,
      { changes: [{ op: "equip", name: "Iron Sword" }] },
      { ...ctx, turnId: "turn-3" },
      mockStore,
    );
    expect(getToolContent(noop).results[0]).toMatchObject({
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
      itemId,
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
    expect(getToolContent(result).applied).toBe(0);
    expect(getToolContent(result).results[0]).toMatchObject({
      status: "skipped",
    });
    const rows = await mockStore.listPluginData("sess-1", "inventory");
    expect(rows).toHaveLength(0);
  });

  it("sees same-turn pending writes so a second call can equip a just-added item", async () => {
    // Arrange — first call adds the item but nothing committed yet
    const first = await updateInventoryTool.execute(
      { changes: [{ op: "add", name: "Iron Sword" }] },
      ctx,
    );

    const itemId = getToolContent(first).results[0].itemId;

    // Act — second call in the same turn equips it via pending overlay
    const second = await updateInventoryTool.execute(
      { changes: [{ op: "equip", name: "Iron Sword" }] },
      { ...ctx, pendingProposals: getPendingProposals(first) },
    );

    // Assert — equip applied, and the merged message keeps both entries
    expect(getToolContent(second).results[0]).toMatchObject({
      status: "updated",
      itemId,
    });
    await commitToolResults([first, second], ctx, mockStore);
    const stored = await mockStore.getPluginData(
      "sess-1",
      "inventory",
      "items",
      itemId,
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
  let vocabularyManifest;
  let loaded;
  let declaration;
  let packageManifest;
  let loadedUi;

  beforeAll(async () => {
    const discoveries = await discoverPlugins(PLUGINS_DIR);
    const discovery = discoveries.find((d) => d.id === "inventory");
    const definition = await loadPluginDefinition(discovery);
    const manifests = definition.manifests;
    packageManifest = definition.packageManifest.manifest;
    loadedUi = await loadPluginUi(discovery, undefined, definition);
    manifest = manifests.find(
      (entry) => entry.manifest.name === "inventory/ledger",
    ).manifest;
    vocabularyManifest = manifests.find(
      (entry) => entry.manifest.name === "inventory/vocabulary",
    ).manifest;
    declaration = definition.packageManifest.plugin;
    loaded = await loadRuntime(discovery, manifest.name, undefined, undefined, {
      "world-ir@1": JSON.parse(
        readContractFile(
          new URL(
            "../../world-ir/schemas/world-ir.schema.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ),
    });
  });

  it("records changes in a post-turn function runtime gated on typed WorldIR", () => {
    expect(manifest.pluginType).toBe("plugin");
    expect(manifest.stage).toBe("post-turn");
    expect(manifest.trigger?.type).toBe("auto");
    expect(manifest.needs).toBeUndefined();
    expect(manifest.inputs?.worldIR).toEqual({
      from: { capability: "world-ir-provider@1", cardinality: "one" },
      accepts: "contract:world-ir@1",
      required: true,
    });
    expect(declaration.requires).toContain("world-ir-provider@1");
    expect(manifest.runtimeType).toBe("function");
    expect(manifest.handler).toBe("./handler.js");
    expect(manifest.tools).toBeUndefined();
    expect(loaded.handler).toBeTypeOf("function");
  });

  it("publishes the bag vocabulary before the narrative", () => {
    expect(vocabularyManifest).toMatchObject({
      runtimeType: "function",
      stage: "pre-turn",
      outputContract: "world-ir.vocabulary@1",
    });
    expect(declaration.provides).toContain("world-ir.vocabulary@1");
  });

  it("declares the player-facing bag command", () => {
    expect(packageManifest.commands).toEqual([
      expect.objectContaining({
        name: "bag",
        aliases: ["inventory"],
        action: "open-bag",
      }),
    ]);
  });

  it("accepts world data into the items namespace", () => {
    const schema = packageManifest.dataSchemas?.items;
    expect(schema).toBeDefined();
    expect(schema.schemaVersion).toBe(1);
    expect(schema.acceptsWorldData).toBe(true);
    expect(schema.schema).toBe("./schemas/items.schema.json");
  });

  it("declares the right panel and message block UI specs", () => {
    expect(packageManifest.ui?.right).toContain("./ui/inventory-panel.json");
    expect(packageManifest.ui?.message).toContain(
      "./ui/inventory-message.json",
    );
  });

  it("loads UI spec JSON with panel metadata", () => {
    expect(loadedUi.uiSpecs?.right).toHaveLength(1);
    expect(loadedUi.uiSpecs?.right?.[0].id).toBe("inventory");
    expect(loadedUi.uiSpecs?.right?.[0].icon).toBe("backpack");
    expect(loadedUi.uiSpecs?.message).toHaveLength(1);
    expect(loadedUi.uiSpecs?.message?.[0].id).toBe("inventory-message");
  });
});

// ── WorldIR mapping, ledger and vocabulary ───────────────────────

describe("inventory from WorldIR", () => {
  const player = { id: "sess-1-player", name: "Ren", type: "player" };
  const worldIR = (events) => ({
    schemaVersion: 1,
    entities: [
      { id: "sess-1-player", type: "character", name: "Ren" },
      { id: "mira", type: "character", name: "Mira" },
      {
        id: "iron-sword",
        type: "item",
        name: "Iron Sword",
        description: "A standard-issue blade.",
        attributes: { tags: ["weapon"] },
      },
      { id: "torch", type: "item", name: "Torch" },
    ],
    relations: [],
    events,
    statements: [],
  });
  const change = (attributes) => ({
    id: `${attributes.operation}-${attributes.item}-${attributes.holder}`,
    type: "inventory_change",
    attributes,
  });

  it("maps the player's item events to ledger changes", () => {
    expect(
      inventoryChangesFromWorldIR(
        worldIR([
          change({
            item: "iron-sword",
            holder: "sess-1-player",
            operation: "gain",
          }),
          change({ item: "iron-sword", holder: "Ren", operation: "equip" }),
          change({
            item: "torch",
            holder: "sess-1-player",
            operation: "lose",
            quantity: 2,
          }),
        ]),
        player,
      ),
    ).toEqual([
      {
        op: "add",
        name: "Iron Sword",
        quantity: 1,
        description: "A standard-issue blade.",
        tags: ["weapon"],
      },
      { op: "remove", name: "Torch", quantity: 2 },
    ]);
  });

  it("ignores other holders, unknown items and malformed operations", () => {
    expect(
      inventoryChangesFromWorldIR(
        worldIR([
          change({ item: "torch", holder: "mira", operation: "gain" }),
          change({
            item: "missing",
            holder: "sess-1-player",
            operation: "gain",
          }),
          change({
            item: "torch",
            holder: "sess-1-player",
            operation: "toString",
          }),
          { id: "moved", type: "movement", attributes: {} },
        ]),
        player,
      ),
    ).toEqual([]);
    expect(inventoryChangesFromWorldIR(worldIR([]), undefined)).toEqual([]);
  });

  it("applies the changes through the ledger without a model call", async () => {
    const result = await ledger({
      sessionId: "sess-1",
      turnId: "turn-1",
      pluginId: "inventory",
      runtimeId: "inventory/ledger",
      store: {
        listPluginData: async () => [],
        getPluginData: async () => null,
      },
      world: { characters: [player] },
      inputs: {
        worldIR: {
          value: worldIR([
            change({
              item: "torch",
              holder: "sess-1-player",
              operation: "gain",
            }),
          ]),
        },
      },
    });

    expect(getToolContent(result)).toMatchObject({
      outcome: "success",
      value: { applied: 1 },
    });
    const [proposal] = getPendingProposals(result);
    expect(proposal.payload.items).toContainEqual(
      expect.objectContaining({
        namespace: "items",
        value: expect.objectContaining({ name: "Torch", quantity: 1 }),
      }),
    );
  });

  it("names the changes beyond the per-turn cap instead of dropping them silently", async () => {
    const events = Array.from({ length: 10 }, (_, index) =>
      change({
        item: `torch-${index}`,
        holder: "sess-1-player",
        operation: "gain",
      }),
    );
    const entities = events.map((_, index) => ({
      id: `torch-${index}`,
      type: "item",
      name: `Torch ${index}`,
    }));
    const result = await ledger({
      sessionId: "sess-1",
      turnId: "turn-1",
      pluginId: "inventory",
      runtimeId: "inventory/ledger",
      store: {
        listPluginData: async () => [],
        getPluginData: async () => null,
      },
      world: { characters: [player] },
      inputs: {
        worldIR: {
          value: {
            ...worldIR(events),
            entities: [...worldIR([]).entities, ...entities],
          },
        },
      },
    });

    const content = getToolContent(result);
    expect(content.value).toMatchObject({ applied: 8, notRecorded: 2 });
    expect(content.value.note).toContain("2 item change(s)");
  });

  it("publishes carried item names and leaves lost items out", async () => {
    const result = await vocabulary({
      store: {
        listPluginData: async () => [
          { key: "item-1", value: { name: "Torch", quantity: 1 } },
          {
            key: "item-2",
            value: { name: "Rope", quantity: 0, removed: true },
          },
        ],
      },
    });
    expect(result).toEqual({
      outcome: "success",
      value: { entries: [{ type: "item", name: "Torch" }] },
    });
  });
});
