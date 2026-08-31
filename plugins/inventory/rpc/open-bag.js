const NAMESPACE = "items";

function isEnglish(locale) {
  return typeof locale === "string" && locale.toLowerCase().startsWith("en");
}

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
  const message = isEnglish(ctx.locale)
    ? `Your bag contains ${itemCount} item ${itemCount === 1 ? "entry" : "entries"}.`
    : `行囊中有 ${itemCount} 项物品。`;

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
