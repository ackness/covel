/**
 * Unified server entry (PLUGIN.md `entry`) — registers inventory's local tool.
 */
import makeUpdateInventory from "../tools/update-inventory.js";

export default function (covel) {
  covel.registerTool(makeUpdateInventory(covel.toolkit));
}
