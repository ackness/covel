import { translate } from "@covel/plugin-handlers-utils";

const NAMESPACE = "items";

/**
 * Player-facing `/bag` command action.
 *
 * @param {unknown} _payload
 * @param {{ sessionId: string, pluginId: string, locale?: string, store: { listPluginData(namespace: string): Promise<Array<{ value?: unknown }>> } }} ctx
 */
export default async function openBag(_payload, ctx) {
  const rows = await ctx.store.listPluginData(NAMESPACE);
  const itemCount = rows.filter((row) => {
    const value = row?.value;
    return value && typeof value === "object" && value.removed !== true;
  }).length;
  const message =
    itemCount === 1
      ? translate(ctx, "Your bag contains {count} item entry.", {
          count: itemCount,
        })
      : translate(ctx, "Your bag contains {count} item entries.", {
          count: itemCount,
        });

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
