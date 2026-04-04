import type { ToolExecutionContext, ToolExecutionResult } from "@covel/shared";
import type { ToolHandler } from "@covel/plugin-runtime";
import { z } from "zod";
import {
  addItem,
  removeItem,
  useItem,
  equipItem,
  modifyCurrency,
  findItemByName,
  createEmptyInventory,
  type InventoryState,
} from "./inventory-logic.js";

// ── Zod Schemas ─────────────────────────────────────────────────

const addItemInputSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  category: z.enum(["weapon", "armor", "consumable", "quest", "material", "misc"]),
  quantity: z.number().optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
});

const removeItemInputSchema = z.object({
  itemId: z.string().optional(),
  itemName: z.string().optional(),
  quantity: z.number().optional(),
});

const useItemInputSchema = z.object({
  itemId: z.string().optional(),
  itemName: z.string().optional(),
});

const equipItemInputSchema = z.object({
  itemId: z.string().optional(),
  itemName: z.string().optional(),
  equip: z.boolean().optional(),
});

const modifyCurrencyInputSchema = z.object({
  currency: z.string(),
  amount: z.number(),
});

// ── Helpers ───────────────────────────────────────────────────────

function getInventory(ctx: ToolExecutionContext): InventoryState {
  const raw = ctx.state;
  if (raw && typeof raw === "object" && "items" in raw) {
    return raw as InventoryState;
  }
  return createEmptyInventory();
}

function generateId(): string {
  return crypto.randomUUID();
}

// ── add-item ──────────────────────────────────────────────────────

interface AddItemInput {
  name: string;
  description?: string;
  category: "weapon" | "armor" | "consumable" | "quest" | "material" | "misc";
  quantity?: number;
  properties?: Record<string, unknown>;
}

export const addItemTool: ToolHandler = async (
  ctx: ToolExecutionContext
): Promise<ToolExecutionResult> => {
  const inventory = getInventory(ctx);
  const parsed = addItemInputSchema.safeParse(ctx.input);
  if (!parsed.success) {
    return { output: { error: parsed.error.message } };
  }
  const input = parsed.data;
  const isZh = ctx.locale.startsWith("zh");

  try {
    const result = addItem(
      inventory,
      {
        name: input.name,
        description: input.description,
        category: input.category,
        quantity: input.quantity,
      },
      generateId
    );

    const message = result.stacked
      ? isZh
        ? `"${result.added.name}" 数量增加到 ${result.added.quantity}。`
        : `"${result.added.name}" quantity increased to ${result.added.quantity}.`
      : isZh
        ? `获得物品: ${result.added.name}${(result.added.quantity > 1) ? ` x${result.added.quantity}` : ""}。`
        : `Acquired: ${result.added.name}${(result.added.quantity > 1) ? ` x${result.added.quantity}` : ""}.`;

    return {
      output: { message },
      proposals: [
        {
          kind: "state.patch",
          payload: { path: "inventory", value: result.inventory },
        },
        {
          kind: "record.upsert",
          payload: {
            key: "inventory:current",
            recordType: "inventory",
            value: result.inventory,
          },
        },
        {
          kind: "event.emit",
          payload: {
            type: "item_acquired",
            data: {
              itemId: result.added.id,
              name: result.added.name,
              category: result.added.category,
              quantity: input.quantity ?? 1,
            },
          },
        },
      ],
    };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    return { output: { error: msg } };
  }
};

// ── remove-item ───────────────────────────────────────────────────

interface RemoveItemInput {
  itemId?: string;
  itemName?: string;
  quantity?: number;
}

export const removeItemTool: ToolHandler = async (
  ctx: ToolExecutionContext
): Promise<ToolExecutionResult> => {
  const inventory = getInventory(ctx);
  const parsed = removeItemInputSchema.safeParse(ctx.input);
  if (!parsed.success) {
    return { output: { error: parsed.error.message } };
  }
  const input = parsed.data;
  const isZh = ctx.locale.startsWith("zh");

  const resolvedId = input.itemId ?? findItemByName(inventory, input.itemName ?? "")?.id;
  if (!resolvedId) {
    const name = input.itemName ?? input.itemId ?? "unknown";
    return {
      output: {
        error: isZh
          ? `未找到物品: ${name}`
          : `Item not found: ${name}`,
      },
    };
  }

  try {
    const result = removeItem(
      inventory,
      resolvedId,
      input.quantity || undefined
    );

    const message = isZh
      ? `移除物品: ${result.removed.name}。`
      : `Removed: ${result.removed.name}.`;

    return {
      output: { message },
      proposals: [
        {
          kind: "state.patch",
          payload: { path: "inventory", value: result.inventory },
        },
        {
          kind: "record.upsert",
          payload: {
            key: "inventory:current",
            recordType: "inventory",
            value: result.inventory,
          },
        },
        {
          kind: "event.emit",
          payload: {
            type: "item_removed",
            data: {
              itemId: resolvedId,
              name: result.removed.name,
              quantity: input.quantity ?? result.removed.quantity,
            },
          },
        },
      ],
    };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    return { output: { error: msg } };
  }
};

// ── use-item ──────────────────────────────────────────────────────

interface UseItemInput {
  itemId?: string;
  itemName?: string;
}

export const useItemTool: ToolHandler = async (
  ctx: ToolExecutionContext
): Promise<ToolExecutionResult> => {
  const inventory = getInventory(ctx);
  const parsed = useItemInputSchema.safeParse(ctx.input);
  if (!parsed.success) {
    return { output: { error: parsed.error.message } };
  }
  const input = parsed.data;
  const isZh = ctx.locale.startsWith("zh");

  const resolvedId = input.itemId ?? findItemByName(inventory, input.itemName ?? "")?.id;
  if (!resolvedId) {
    const name = input.itemName ?? input.itemId ?? "unknown";
    return {
      output: {
        error: isZh
          ? `未找到物品: ${name}`
          : `Item not found: ${name}`,
      },
    };
  }

  try {
    const result = useItem(inventory, resolvedId);

    const message = isZh
      ? `使用了 ${result.used.name}。效果: ${result.effect}`
      : `Used ${result.used.name}. Effect: ${result.effect}`;

    return {
      output: { message },
      proposals: [
        {
          kind: "state.patch",
          payload: { path: "inventory", value: result.inventory },
        },
        {
          kind: "record.upsert",
          payload: {
            key: "inventory:current",
            recordType: "inventory",
            value: result.inventory,
          },
        },
        {
          kind: "event.emit",
          payload: {
            type: "item_used",
            data: {
              itemId: resolvedId,
              name: result.used.name,
              effect: result.effect,
            },
          },
        },
        {
          kind: "narrative.append",
          payload: { text: result.effect },
        },
      ],
    };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    return { output: { error: msg } };
  }
};

// ── equip-item ────────────────────────────────────────────────────

interface EquipItemInput {
  itemId?: string;
  itemName?: string;
  equip?: boolean;
}

export const equipItemTool: ToolHandler = async (
  ctx: ToolExecutionContext
): Promise<ToolExecutionResult> => {
  const inventory = getInventory(ctx);
  const parsed = equipItemInputSchema.safeParse(ctx.input);
  if (!parsed.success) {
    return { output: { error: parsed.error.message } };
  }
  const input = parsed.data;
  const isZh = ctx.locale.startsWith("zh");

  const resolvedId = input.itemId ?? findItemByName(inventory, input.itemName ?? "")?.id;
  if (!resolvedId) {
    const name = input.itemName ?? input.itemId ?? "unknown";
    return {
      output: {
        error: isZh
          ? `未找到物品: ${name}`
          : `Item not found: ${name}`,
      },
    };
  }

  try {
    const result = equipItem(inventory, resolvedId, input.equip);

    const action = result.equipped.equipped
      ? isZh ? "装备" : "equipped"
      : isZh ? "卸下" : "unequipped";
    const message = isZh
      ? `${action}了 ${result.equipped.name}。`
      : `${action} ${result.equipped.name}.`;

    return {
      output: { message },
      proposals: [
        {
          kind: "state.patch",
          payload: { path: "inventory", value: result.inventory },
        },
        {
          kind: "record.upsert",
          payload: {
            key: "inventory:current",
            recordType: "inventory",
            value: result.inventory,
          },
        },
        {
          kind: "event.emit",
          payload: {
            type: "item_equipped",
            data: {
              itemId: resolvedId,
              name: result.equipped.name,
              equipped: result.equipped.equipped,
            },
          },
        },
      ],
    };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    return { output: { error: msg } };
  }
};

// ── modify-currency ───────────────────────────────────────────────

interface ModifyCurrencyInput {
  currency: string;
  amount: number;
}

export const modifyCurrencyTool: ToolHandler = async (
  ctx: ToolExecutionContext
): Promise<ToolExecutionResult> => {
  const inventory = getInventory(ctx);
  const parsed = modifyCurrencyInputSchema.safeParse(ctx.input);
  if (!parsed.success) {
    return { output: { error: parsed.error.message } };
  }
  const input = parsed.data;
  const isZh = ctx.locale.startsWith("zh");

  try {
    const updatedInventory = modifyCurrency(inventory, input.currency, input.amount);

    const newAmount = updatedInventory.currency[input.currency] ?? 0;
    const message =
      input.amount >= 0
        ? isZh
          ? `获得 ${input.amount} ${input.currency} (当前: ${newAmount})。`
          : `Gained ${input.amount} ${input.currency} (current: ${newAmount}).`
        : isZh
          ? `花费 ${Math.abs(input.amount)} ${input.currency} (当前: ${newAmount})。`
          : `Spent ${Math.abs(input.amount)} ${input.currency} (current: ${newAmount}).`;

    return {
      output: { message },
      proposals: [
        {
          kind: "state.patch",
          payload: { path: "inventory", value: updatedInventory },
        },
        {
          kind: "record.upsert",
          payload: {
            key: "inventory:current",
            recordType: "inventory",
            value: updatedInventory,
          },
        },
        {
          kind: "event.emit",
          payload: {
            type: "currency_changed",
            data: {
              currency: input.currency,
              amount: input.amount,
              newTotal: newAmount,
            },
          },
        },
      ],
    };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    return { output: { error: msg } };
  }
};
