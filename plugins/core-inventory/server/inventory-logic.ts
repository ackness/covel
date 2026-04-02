/**
 * Pure business logic for inventory operations.
 * All functions are immutable — they return new state, never mutate input.
 */

export interface InventoryItem {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly category:
    | "weapon"
    | "armor"
    | "consumable"
    | "quest"
    | "material"
    | "misc";
  readonly quantity: number;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly equipped?: boolean;
  readonly acquiredTurnId?: string;
}

export interface InventoryState {
  readonly items: readonly InventoryItem[];
  readonly currency: Readonly<Record<string, number>>;
  readonly capacity: number;
}

export const DEFAULT_CAPACITY = 50;

export function createEmptyInventory(
  capacity: number = DEFAULT_CAPACITY
): InventoryState {
  return { items: [], currency: {}, capacity };
}

// ── Add Item ──────────────────────────────────────────────────────

export interface AddItemInput {
  readonly name: string;
  readonly description?: string;
  readonly category: InventoryItem["category"];
  readonly quantity?: number;
  readonly properties?: Record<string, unknown>;
  readonly acquiredTurnId?: string;
}

export interface AddItemResult {
  readonly inventory: InventoryState;
  readonly added: InventoryItem;
  readonly stacked: boolean;
}

export function addItem(
  inventory: InventoryState,
  input: AddItemInput,
  generateId: () => string
): AddItemResult {
  const quantity = input.quantity ?? 1;
  if (quantity <= 0) {
    throw new Error("Quantity must be positive");
  }

  // Check if a stackable item with the same name and category exists
  const existingIndex = inventory.items.findIndex(
    (item) => item.name === input.name && item.category === input.category
  );

  if (existingIndex >= 0) {
    const existing = inventory.items[existingIndex]!;
    const updated: InventoryItem = {
      ...existing,
      quantity: existing.quantity + quantity,
    };
    const newItems = inventory.items.map((item, i) =>
      i === existingIndex ? updated : item
    );
    return {
      inventory: { ...inventory, items: newItems },
      added: updated,
      stacked: true,
    };
  }

  // Check capacity (count unique item slots, not total quantity)
  if (inventory.items.length >= inventory.capacity) {
    throw new Error(
      `Inventory full (${inventory.capacity}/${inventory.capacity})`
    );
  }

  const newItem: InventoryItem = {
    id: generateId(),
    name: input.name,
    description: input.description ?? "",
    category: input.category,
    quantity,
    properties: input.properties,
    equipped: false,
    acquiredTurnId: input.acquiredTurnId,
  };

  return {
    inventory: { ...inventory, items: [...inventory.items, newItem] },
    added: newItem,
    stacked: false,
  };
}

// ── Remove Item ───────────────────────────────────────────────────

export interface RemoveItemResult {
  readonly inventory: InventoryState;
  readonly removed: InventoryItem;
  readonly remainingQuantity: number;
}

export function removeItem(
  inventory: InventoryState,
  itemId: string,
  quantity?: number
): RemoveItemResult {
  const item = inventory.items.find((i) => i.id === itemId);
  if (!item) {
    throw new Error(`Item not found: ${itemId}`);
  }

  const removeQty = quantity ?? item.quantity; // default: remove all
  if (removeQty <= 0) {
    throw new Error("Quantity must be positive");
  }
  if (removeQty > item.quantity) {
    throw new Error(
      `Cannot remove ${removeQty} of "${item.name}" (have ${item.quantity})`
    );
  }

  const remaining = item.quantity - removeQty;

  if (remaining === 0) {
    return {
      inventory: {
        ...inventory,
        items: inventory.items.filter((i) => i.id !== itemId),
      },
      removed: item,
      remainingQuantity: 0,
    };
  }

  const updated: InventoryItem = { ...item, quantity: remaining };
  return {
    inventory: {
      ...inventory,
      items: inventory.items.map((i) => (i.id === itemId ? updated : i)),
    },
    removed: item,
    remainingQuantity: remaining,
  };
}

// ── Use Item ──────────────────────────────────────────────────────

export interface UseItemResult {
  readonly inventory: InventoryState;
  readonly used: InventoryItem;
  readonly effect: string;
}

export function useItem(
  inventory: InventoryState,
  itemId: string
): UseItemResult {
  const item = inventory.items.find((i) => i.id === itemId);
  if (!item) {
    throw new Error(`Item not found: ${itemId}`);
  }

  if (item.category !== "consumable") {
    throw new Error(`"${item.name}" is not consumable (category: ${item.category})`);
  }

  if (item.quantity <= 0) {
    throw new Error(`No "${item.name}" left to use`);
  }

  const effect =
    typeof item.properties?.["effect"] === "string"
      ? item.properties["effect"]
      : `Used ${item.name}`;

  const remaining = item.quantity - 1;
  const newItems =
    remaining === 0
      ? inventory.items.filter((i) => i.id !== itemId)
      : inventory.items.map((i) =>
          i.id === itemId ? { ...i, quantity: remaining } : i
        );

  return {
    inventory: { ...inventory, items: newItems },
    used: item,
    effect,
  };
}

// ── Equip Item ────────────────────────────────────────────────────

export interface EquipItemResult {
  readonly inventory: InventoryState;
  readonly equipped: InventoryItem;
}

export function equipItem(
  inventory: InventoryState,
  itemId: string,
  equip?: boolean
): EquipItemResult {
  const item = inventory.items.find((i) => i.id === itemId);
  if (!item) {
    throw new Error(`Item not found: ${itemId}`);
  }

  if (item.category !== "weapon" && item.category !== "armor") {
    throw new Error(
      `"${item.name}" cannot be equipped (category: ${item.category})`
    );
  }

  const newEquipped = equip ?? !item.equipped;
  const updated: InventoryItem = { ...item, equipped: newEquipped };

  return {
    inventory: {
      ...inventory,
      items: inventory.items.map((i) => (i.id === itemId ? updated : i)),
    },
    equipped: updated,
  };
}

// ── Modify Currency ───────────────────────────────────────────────

export function modifyCurrency(
  inventory: InventoryState,
  currency: string,
  amount: number
): InventoryState {
  const current = inventory.currency[currency] ?? 0;
  const newAmount = current + amount;

  if (newAmount < 0) {
    throw new Error(
      `Insufficient ${currency}: have ${current}, need ${Math.abs(amount)}`
    );
  }

  return {
    ...inventory,
    currency: { ...inventory.currency, [currency]: newAmount },
  };
}

// ── Find Item by Name ─────────────────────────────────────────────

export function findItemByName(
  inventory: InventoryState,
  name: string
): InventoryItem | undefined {
  const lower = name.toLowerCase();
  return inventory.items.find((i) => i.name.toLowerCase() === lower);
}

// ── Inventory Summary ─────────────────────────────────────────────

export function getInventorySummary(
  inventory: InventoryState,
  locale: string
): string {
  const isZh = locale.startsWith("zh");
  const lines: string[] = [];

  if (inventory.items.length === 0) {
    lines.push(isZh ? "背包为空。" : "Inventory is empty.");
  } else {
    lines.push(
      isZh
        ? `背包 (${inventory.items.length}/${inventory.capacity}):`
        : `Inventory (${inventory.items.length}/${inventory.capacity}):`
    );

    for (const item of inventory.items) {
      const equippedTag = item.equipped ? (isZh ? " [装备中]" : " [equipped]") : "";
      const qtyTag = item.quantity > 1 ? ` x${item.quantity}` : "";
      lines.push(`  - ${item.name}${qtyTag} (${item.category})${equippedTag}`);
    }
  }

  const currencies = Object.entries(inventory.currency).filter(
    ([, v]) => v > 0
  );
  if (currencies.length > 0) {
    lines.push(
      isZh ? "货币:" : "Currency:",
      ...currencies.map(([name, amount]) => `  - ${name}: ${amount}`)
    );
  }

  return lines.join("\n");
}
