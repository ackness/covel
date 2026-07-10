/**
 * Unified server entry (PLUGIN.md `entry`) — registers the extractor
 * runtime's local tools (tool files live at the plugin root `tools/`).
 */
import makeUpsertNpcGraph from "../tools/upsert-npc-graph.js";
import makeListNpcGraph from "../tools/list-npc-graph.js";

export default function (covel) {
  covel.registerTool(makeUpsertNpcGraph(covel.toolkit));
  covel.registerTool(makeListNpcGraph(covel.toolkit));
}
