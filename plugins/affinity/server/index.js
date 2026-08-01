/**
 * Unified server entry (PLUGIN.md `entry`) — registers affinity's local tools.
 */
import makeUpdateAffinity from "../tools/update-affinity.js";

export default function (covel) {
  covel.registerTool(makeUpdateAffinity(covel.toolkit));
}
