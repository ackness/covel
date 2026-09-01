import { pickLocaleText } from "@covel/plugin-handlers-utils";

const NAMESPACE = "items";

/**
 * Player-facing `/bag` command action.
 *
 * @param {unknown} _payload
 * @param {{ sessionId: string, pluginId: string, locale?: string, store: { listPluginData(sessionId: string, pluginId: string, namespace: string): Promise<Array<{ value?: unknown }>> } }} ctx
 */
export default async function openBag(_payload, ctx) {
  const rows = await ctx.store.listPluginData(
    ctx.sessionId,
    ctx.pluginId,
    NAMESPACE,
  );
  const itemCount = rows.filter((row) => {
    const value = row?.value;
    return value && typeof value === "object" && value.removed !== true;
  }).length;
  const message = pickLocaleText(
    ctx.locale,
    `行囊中有 ${itemCount} 项物品。`,
    `Your bag contains ${itemCount} item ${itemCount === 1 ? "entry" : "entries"}.`,
  );

  return {
    ok: true,
    message,
    data: { itemCount },
    clientAction: {
      type: "open-plugin-panel",
      panelId: "inventory",
    },
  };
}
