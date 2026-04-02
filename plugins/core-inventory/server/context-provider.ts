import type { ContextProviderInput } from "@covel/plugin-runtime";
import {
  getInventorySummary,
  createEmptyInventory,
  type InventoryState,
} from "./inventory-logic.js";

/**
 * Injects the current inventory state as context for other runtimes (e.g. narrator).
 * This lets the narrator know what the player is carrying.
 */
export async function inventoryContextProvider(input: ContextProviderInput): Promise<{
  id: string;
  title: string;
  content: string;
  priority: number;
}> {
  const isZh = input.locale.startsWith("zh");

  const state = input.state as Record<string, unknown> | undefined;
  const inventory = (state?.["inventory"] as InventoryState) ?? createEmptyInventory();
  const summary = getInventorySummary(inventory, input.locale);

  return {
    id: "inventory-state",
    title: isZh ? "玩家物品栏" : "Player Inventory",
    content: summary,
    priority: 40,
  };
}
