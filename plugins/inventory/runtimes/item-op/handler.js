/**
 * Player-side loadout changes from the inventory panel. Writes are staged
 * for proposal validation and committed with this manual execution.
 */

import { translate } from "@covel/plugin-handlers-utils";

const NAMESPACE = "items";

/** @type {import("@covel/plugin-handlers-utils").PluginFunctionHandler} */
export default async function itemOp(ctx) {
  const payload = ctx.manualPayload;
  const body = payload && typeof payload === "object" ? payload : {};
  const op = typeof body.op === "string" ? body.op : "";
  const itemId = typeof body.itemId === "string" ? body.itemId : "";
  if (!["equip", "unequip", "drop"].includes(op) || !itemId) {
    return {
      outcome: "failed",
      error: translate(ctx, "That bag action is not supported."),
    };
  }

  const item = await ctx.pluginData.get(NAMESPACE, itemId);
  if (!item || typeof item !== "object" || item.removed === true) {
    return {
      outcome: "failed",
      error: translate(ctx, "That item is no longer in your bag."),
    };
  }

  // The summary slot sorts by `updatedAt`, so a panel action counts as a change.
  const updatedAt = new Date().toISOString();
  const value =
    op === "drop"
      ? { ...item, quantity: 0, equipped: false, removed: true, updatedAt }
      : { ...item, equipped: op === "equip", updatedAt };

  await ctx.pluginData.set(NAMESPACE, itemId, value);
  return { outcome: "success", value: { op, item: value } };
}
