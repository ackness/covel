import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { validateManifest } from "@covel/plugin-runtime";
import {
  addItem,
  removeItem,
  useItem,
  equipItem,
  modifyCurrency,
  findItemByName,
  getInventorySummary,
  createEmptyInventory,
  type InventoryState,
  type InventoryItem,
} from "../server/inventory-logic.js";
import {
  addItemTool,
  removeItemTool,
  useItemTool,
  equipItemTool,
  modifyCurrencyTool,
} from "../server/tools.js";
import { inventoryContextProvider } from "../server/context-provider.js";

// ── plugin.json manifest ────────────────────────────────────────

describe("plugin.json manifest", () => {
  it("passes schema validation", () => {
    const raw = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../plugin.json"), "utf-8"),
    );
    const result = validateManifest(raw);
    if (!result.ok) {
      throw new Error(
        `Manifest validation failed:\n${result.errors.map((e) => `  - ${e}`).join("\n")}`,
      );
    }
    expect(result.ok).toBe(true);
  });
});

// ── Helpers ───────────────────────────────────────────────────────

let idCounter = 0;
function mockGenerateId(): string {
  return `test-id-${++idCounter}`;
}

function makeInventory(
  items: InventoryItem[] = [],
  currency: Record<string, number> = {},
  capacity = 50
): InventoryState {
  return { items, currency, capacity };
}

function makeItem(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: mockGenerateId(),
    name: "Test Item",
    description: "A test item",
    category: "misc",
    quantity: 1,
    equipped: false,
    ...overrides,
  };
}

// ── Pure Logic Tests ──────────────────────────────────────────────

describe("inventory-logic", () => {
  describe("addItem", () => {
    it("adds a new item to empty inventory", () => {
      const inv = createEmptyInventory();
      const result = addItem(
        inv,
        { name: "Iron Sword", category: "weapon" },
        mockGenerateId
      );

      expect(result.added.name).toBe("Iron Sword");
      expect(result.added.category).toBe("weapon");
      expect(result.added.quantity).toBe(1);
      expect(result.stacked).toBe(false);
      expect(result.inventory.items).toHaveLength(1);
    });

    it("stacks items with same name and category", () => {
      const existing = makeItem({
        name: "Health Potion",
        category: "consumable",
        quantity: 3,
      });
      const inv = makeInventory([existing]);

      const result = addItem(
        inv,
        { name: "Health Potion", category: "consumable", quantity: 2 },
        mockGenerateId
      );

      expect(result.stacked).toBe(true);
      expect(result.added.quantity).toBe(5);
      expect(result.inventory.items).toHaveLength(1);
    });

    it("does not stack items with different categories", () => {
      const existing = makeItem({
        name: "Iron",
        category: "material",
        quantity: 5,
      });
      const inv = makeInventory([existing]);

      const result = addItem(
        inv,
        { name: "Iron", category: "weapon" },
        mockGenerateId
      );

      expect(result.stacked).toBe(false);
      expect(result.inventory.items).toHaveLength(2);
    });

    it("throws when inventory is full", () => {
      const items = Array.from({ length: 3 }, (_, i) =>
        makeItem({ name: `Item ${i}` })
      );
      const inv = makeInventory(items, {}, 3);

      expect(() =>
        addItem(inv, { name: "Overflow", category: "misc" }, mockGenerateId)
      ).toThrow("Inventory full");
    });

    it("throws on zero or negative quantity", () => {
      const inv = createEmptyInventory();
      expect(() =>
        addItem(inv, { name: "Bad", category: "misc", quantity: 0 }, mockGenerateId)
      ).toThrow("Quantity must be positive");
    });

    it("preserves original inventory (immutability)", () => {
      const inv = createEmptyInventory();
      const result = addItem(
        inv,
        { name: "Sword", category: "weapon" },
        mockGenerateId
      );

      expect(inv.items).toHaveLength(0);
      expect(result.inventory.items).toHaveLength(1);
    });
  });

  describe("removeItem", () => {
    it("removes item completely when no quantity specified", () => {
      const item = makeItem({ name: "Shield", quantity: 1 });
      const inv = makeInventory([item]);

      const result = removeItem(inv, item.id);
      expect(result.inventory.items).toHaveLength(0);
      expect(result.remainingQuantity).toBe(0);
    });

    it("decreases quantity when partial removal", () => {
      const item = makeItem({ name: "Arrow", quantity: 50 });
      const inv = makeInventory([item]);

      const result = removeItem(inv, item.id, 10);
      expect(result.inventory.items).toHaveLength(1);
      expect(result.inventory.items[0]!.quantity).toBe(40);
      expect(result.remainingQuantity).toBe(40);
    });

    it("throws when item not found", () => {
      const inv = createEmptyInventory();
      expect(() => removeItem(inv, "nonexistent")).toThrow("Item not found");
    });

    it("throws when removing more than available", () => {
      const item = makeItem({ name: "Potion", quantity: 2 });
      const inv = makeInventory([item]);

      expect(() => removeItem(inv, item.id, 5)).toThrow("Cannot remove");
    });
  });

  describe("useItem", () => {
    it("uses a consumable item and reduces quantity", () => {
      const item = makeItem({
        name: "Healing Potion",
        category: "consumable",
        quantity: 3,
        properties: { effect: "Restores 50 HP" },
      });
      const inv = makeInventory([item]);

      const result = useItem(inv, item.id);
      expect(result.inventory.items[0]!.quantity).toBe(2);
      expect(result.effect).toBe("Restores 50 HP");
    });

    it("removes item when last one is used", () => {
      const item = makeItem({
        name: "Scroll",
        category: "consumable",
        quantity: 1,
      });
      const inv = makeInventory([item]);

      const result = useItem(inv, item.id);
      expect(result.inventory.items).toHaveLength(0);
    });

    it("throws when item is not consumable", () => {
      const item = makeItem({ name: "Sword", category: "weapon" });
      const inv = makeInventory([item]);

      expect(() => useItem(inv, item.id)).toThrow("not consumable");
    });

    it("provides default effect when no effect property", () => {
      const item = makeItem({
        name: "Berry",
        category: "consumable",
        quantity: 1,
      });
      const inv = makeInventory([item]);

      const result = useItem(inv, item.id);
      expect(result.effect).toBe("Used Berry");
    });
  });

  describe("equipItem", () => {
    it("equips a weapon", () => {
      const item = makeItem({
        name: "Longsword",
        category: "weapon",
        equipped: false,
      });
      const inv = makeInventory([item]);

      const result = equipItem(inv, item.id, true);
      expect(result.equipped.equipped).toBe(true);
    });

    it("unequips armor", () => {
      const item = makeItem({
        name: "Plate Armor",
        category: "armor",
        equipped: true,
      });
      const inv = makeInventory([item]);

      const result = equipItem(inv, item.id, false);
      expect(result.equipped.equipped).toBe(false);
    });

    it("toggles when equip is not specified", () => {
      const item = makeItem({
        name: "Shield",
        category: "armor",
        equipped: false,
      });
      const inv = makeInventory([item]);

      const result = equipItem(inv, item.id);
      expect(result.equipped.equipped).toBe(true);
    });

    it("throws for non-equippable items", () => {
      const item = makeItem({ name: "Potion", category: "consumable" });
      const inv = makeInventory([item]);

      expect(() => equipItem(inv, item.id)).toThrow("cannot be equipped");
    });
  });

  describe("modifyCurrency", () => {
    it("adds currency to empty wallet", () => {
      const inv = createEmptyInventory();
      const result = modifyCurrency(inv, "gold", 100);

      expect(result.currency["gold"]).toBe(100);
    });

    it("adds to existing currency", () => {
      const inv = makeInventory([], { gold: 50 });
      const result = modifyCurrency(inv, "gold", 30);

      expect(result.currency["gold"]).toBe(80);
    });

    it("subtracts currency", () => {
      const inv = makeInventory([], { gold: 100 });
      const result = modifyCurrency(inv, "gold", -40);

      expect(result.currency["gold"]).toBe(60);
    });

    it("throws on insufficient funds", () => {
      const inv = makeInventory([], { gold: 10 });
      expect(() => modifyCurrency(inv, "gold", -50)).toThrow("Insufficient");
    });

    it("preserves other currencies", () => {
      const inv = makeInventory([], { gold: 100, silver: 50 });
      const result = modifyCurrency(inv, "gold", -10);

      expect(result.currency["gold"]).toBe(90);
      expect(result.currency["silver"]).toBe(50);
    });
  });

  describe("findItemByName", () => {
    it("finds item case-insensitively", () => {
      const item = makeItem({ name: "Magic Wand" });
      const inv = makeInventory([item]);

      expect(findItemByName(inv, "magic wand")).toBe(item);
      expect(findItemByName(inv, "MAGIC WAND")).toBe(item);
    });

    it("returns undefined when not found", () => {
      const inv = createEmptyInventory();
      expect(findItemByName(inv, "Nothing")).toBeUndefined();
    });
  });

  describe("getInventorySummary", () => {
    it("shows empty message for empty inventory (zh)", () => {
      const inv = createEmptyInventory();
      const summary = getInventorySummary(inv, "zh-CN");
      expect(summary).toContain("背包为空");
    });

    it("shows empty message for empty inventory (en)", () => {
      const inv = createEmptyInventory();
      const summary = getInventorySummary(inv, "en-US");
      expect(summary).toContain("Inventory is empty");
    });

    it("lists items and currency", () => {
      const items = [
        makeItem({ name: "Sword", category: "weapon", equipped: true }),
        makeItem({ name: "Potion", category: "consumable", quantity: 3 }),
      ];
      const inv = makeInventory(items, { gold: 100 });

      const summary = getInventorySummary(inv, "en-US");
      expect(summary).toContain("Sword");
      expect(summary).toContain("[equipped]");
      expect(summary).toContain("Potion");
      expect(summary).toContain("x3");
      expect(summary).toContain("gold: 100");
    });
  });
});

// ── Tool Tests ────────────────────────────────────────────────────

describe("tools", () => {
  function makeToolCtx<T>(input: T, state?: unknown): Record<string, unknown> {
    return {
      input,
      runtimeId: "inventory-tracker",
      pluginId: "core-inventory",
      locale: "en-US",
      state: state ?? createEmptyInventory(),
    };
  }

  describe("addItemTool", () => {
    it("returns proposals for a new item", async () => {
      const ctx = makeToolCtx({
        name: "Iron Sword",
        category: "weapon",
      });

      const result = await addItemTool(
        ctx as unknown as Parameters<typeof addItemTool>[0]
      );

      expect(result.output).toHaveProperty("message");
      expect(result.proposals).toBeDefined();
      expect(result.proposals).toHaveLength(2);
      expect(result.proposals![0]!.kind).toBe("state.patch");
      expect(result.proposals![1]!.kind).toBe("event.emit");
    });

    it("returns error for full inventory", async () => {
      const items = Array.from({ length: 50 }, (_, i) =>
        makeItem({ name: `Item ${i}` })
      );
      const inv = makeInventory(items, {}, 50);
      const ctx = makeToolCtx(
        { name: "Overflow", category: "misc" },
        inv
      );

      const result = await addItemTool(
        ctx as unknown as Parameters<typeof addItemTool>[0]
      );

      expect(result.output).toHaveProperty("error");
      expect(result.proposals).toBeUndefined();
    });
  });

  describe("removeItemTool", () => {
    it("removes item by name", async () => {
      const item = makeItem({ name: "Old Shield", category: "armor" });
      const inv = makeInventory([item]);
      const ctx = makeToolCtx({ itemName: "Old Shield" }, inv);

      const result = await removeItemTool(
        ctx as unknown as Parameters<typeof removeItemTool>[0]
      );

      expect(result.output).toHaveProperty("message");
      expect(result.proposals).toHaveLength(2);
    });

    it("returns error for nonexistent item", async () => {
      const ctx = makeToolCtx({ itemName: "Ghost Item" });

      const result = await removeItemTool(
        ctx as unknown as Parameters<typeof removeItemTool>[0]
      );

      expect(result.output).toHaveProperty("error");
    });
  });

  describe("useItemTool", () => {
    it("uses a consumable and returns narrative proposal", async () => {
      const item = makeItem({
        name: "Health Potion",
        category: "consumable",
        quantity: 2,
        properties: { effect: "Restores 50 HP" },
      });
      const inv = makeInventory([item]);
      const ctx = makeToolCtx({ itemName: "Health Potion" }, inv);

      const result = await useItemTool(
        ctx as unknown as Parameters<typeof useItemTool>[0]
      );

      expect(result.output).toHaveProperty("message");
      expect(result.proposals).toHaveLength(3); // state.patch + event.emit + narrative.append
      expect(result.proposals![2]!.kind).toBe("narrative.append");
    });
  });

  describe("equipItemTool", () => {
    it("equips a weapon", async () => {
      const item = makeItem({
        name: "Silver Sword",
        category: "weapon",
        equipped: false,
      });
      const inv = makeInventory([item]);
      const ctx = makeToolCtx({ itemName: "Silver Sword", equip: true }, inv);

      const result = await equipItemTool(
        ctx as unknown as Parameters<typeof equipItemTool>[0]
      );

      expect(result.output).toHaveProperty("message");
      expect(result.proposals).toHaveLength(2);
    });
  });

  describe("modifyCurrencyTool", () => {
    it("adds gold", async () => {
      const inv = makeInventory([], { gold: 50 });
      const ctx = makeToolCtx({ currency: "gold", amount: 100 }, inv);

      const result = await modifyCurrencyTool(
        ctx as unknown as Parameters<typeof modifyCurrencyTool>[0]
      );

      expect(result.output).toHaveProperty("message");
      expect(result.proposals).toHaveLength(2);
    });

    it("returns error for insufficient funds", async () => {
      const inv = makeInventory([], { gold: 10 });
      const ctx = makeToolCtx({ currency: "gold", amount: -100 }, inv);

      const result = await modifyCurrencyTool(
        ctx as unknown as Parameters<typeof modifyCurrencyTool>[0]
      );

      expect(result.output).toHaveProperty("error");
    });
  });
});

// ── Context Provider Tests ────────────────────────────────────────

describe("inventoryContextProvider", () => {
  it("returns inventory summary for zh-CN", async () => {
    const result = await inventoryContextProvider({
      pluginId: "core-inventory",
      runtimeId: "narrator",
      locale: "zh-CN",
      state: {
        inventory: makeInventory(
          [makeItem({ name: "Iron Sword", category: "weapon" })],
          { gold: 100 }
        ),
      },
    });

    expect(result).toHaveProperty("id", "inventory-state");
    expect(result).toHaveProperty("title", "玩家物品栏");
    expect(result.content).toContain("Iron Sword");
    expect(result.content).toContain("gold: 100");
  });

  it("handles empty state gracefully", async () => {
    const result = await inventoryContextProvider({
      pluginId: "core-inventory",
      runtimeId: "narrator",
      locale: "en-US",
    });

    expect(result.content).toContain("Inventory is empty");
  });
});
