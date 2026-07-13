/**
 * Unified server entry (PLUGIN.md `entry`) — registers the schema-gen
 * runtime's local tools (tool files live at the plugin root `tools/`).
 */
import makeSetWorldSchema from "../tools/set-world-schema.js";
import makeSetWorldEntriesBatch from "../tools/set-world-entries-batch.js";

export default function (covel) {
  covel.registerTool(makeSetWorldSchema(covel.toolkit));
  covel.registerTool(makeSetWorldEntriesBatch(covel.toolkit));
}
