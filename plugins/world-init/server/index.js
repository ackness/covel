/**
 * Unified server entry (PLUGIN.md `entry`) — registers the schema-gen
 * runtime's local tools (tool files live at the plugin root `tools/`).
 */
import makeWorldDimensionGet from "../tools/world-dimension-get.js";
import makeSetWorldSchema from "../tools/set-world-schema.js";
import makeSetWorldEntriesBatch from "../tools/set-world-entries-batch.js";
import makeInitializeWorld from "../tools/initialize-world.js";

export default function (covel) {
  covel.provideExtension("session.world-context@1", "world-context", {
    async handler(_input, ctx) {
      const rows = await ctx.pluginData.list("entries");
      const source = ctx.world.worldRecord?.metadata?.dimensions;
      const dimensions =
        source && typeof source === "object" && !Array.isArray(source)
          ? source
          : {};
      return {
        schema: ctx.world.characterSchema ?? {},
        entries: {
          ...dimensions,
          ...Object.fromEntries(rows.map((row) => [row.key, row.value])),
        },
      };
    },
  });
  covel.registerTool(makeWorldDimensionGet(covel.toolkit));
  covel.registerTool(makeSetWorldSchema(covel.toolkit));
  covel.registerTool(makeSetWorldEntriesBatch(covel.toolkit));
  covel.registerTool(makeInitializeWorld(covel.toolkit));
}
