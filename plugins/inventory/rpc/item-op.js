/**
 * Player-side item operations, exposed as the `item-op` RPC action and
 * triggered by the inventory panel's per-item buttons.
 *
 * Scope is deliberately loadout-only: `equip` / `unequip` / `drop`. Narrative
 * consumption ("I use the bandage") stays in the story loop — a silent
 * "use" button would bypass the narrator entirely. `drop` writes the same
 * tombstone shape as the tool's remove-to-zero (`quantity: 0, removed: true`)
 * so LLM-side and player-side removals share one model and same-name
 * re-acquisition revives the same record id.
 */

const NAMESPACE = "items";

/**
 * @param {unknown} payload  `{ op: "equip"|"unequip"|"drop", itemId: string }`
 * @param {{ sessionId: string, pluginId: string, action: string, store: any }} ctx
 */
export default async function itemOp(payload, ctx) {
  const body = payload && typeof payload === "object" ? payload : {};
  const op = typeof body.op === "string" ? body.op : "";
  const itemId = typeof body.itemId === "string" ? body.itemId : "";
  if (!["equip", "unequip", "drop"].includes(op) || !itemId) {
    return {
      ok: false,
      reason: 'payload must be { op: "equip"|"unequip"|"drop", itemId }',
    };
  }

  const row = await ctx.store.getPluginData(
    ctx.sessionId,
    ctx.pluginId,
    NAMESPACE,
    itemId,
  );
  const item = row?.value;
  if (!item || typeof item !== "object" || item.removed === true) {
    return { ok: false, reason: `item "${itemId}" not found` };
  }

  const value =
    op === "drop"
      ? { ...item, quantity: 0, equipped: false, removed: true }
      : { ...item, equipped: op === "equip" };

  // Direct-store writes need the FULL PluginDataRecord (id/createdAt/…) —
  // spread the loaded row so the upsert keeps its identity and timestamps,
  // only the value and updatedAt change.
  await ctx.store.setPluginData({
    ...row,
    value,
    updatedAt: new Date().toISOString(),
  });
  return { ok: true, op, item: value };
}
