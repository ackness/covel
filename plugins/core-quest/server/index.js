/**
 * Unified server entry (PLUGIN.md `entry`) — registers core-quest's local tools.
 */
import makeUpsertQuests from "../tools/upsert-quests.js";

export default function (covel) {
  covel.registerTool(makeUpsertQuests(covel.toolkit));
}
