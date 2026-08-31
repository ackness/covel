/**
 * Unified server entry (PLUGIN.md `entry`) — registers inventory's local tool
 * and the player-side item-op RPC action (panel buttons).
 */
import makeUpdateInventory from "../tools/update-inventory.js";
import itemOp from "../rpc/item-op.js";
import openBag from "../rpc/open-bag.js";

export default function (covel) {
  covel.registerTool(makeUpdateInventory(covel.toolkit));
  covel.registerRpc("item-op", itemOp, {
    description: "Equip, unequip, or drop an inventory item (player action)",
  });
  covel.registerRpc("open-bag", openBag, {
    description: "Count carried items and open the inventory panel",
  });
}
