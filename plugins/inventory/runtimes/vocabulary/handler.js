const MAX_ENTRIES = 80;

/**
 * Publish the names of the items in the bag so the shared WorldIR extraction
 * reuses them instead of inventing variants.
 *
 * @type {import("@covel/plugin-handlers-utils").PluginFunctionHandler}
 */
export default async function handler(ctx) {
  const rows = (await ctx.store.listPluginData("items")) ?? [];
  const entries = rows
    .map((row) => row.value)
    .filter(
      (item) =>
        item &&
        item.removed !== true &&
        typeof item.name === "string" &&
        item.name.trim(),
    )
    .slice(0, MAX_ENTRIES)
    .map((item) => ({ type: "item", name: item.name.trim() }));
  return { outcome: "success", value: { entries } };
}
