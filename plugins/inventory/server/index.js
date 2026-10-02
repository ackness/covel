/**
 * Unified server entry (PLUGIN.md `entry`) — registers the player-side
 * item-op RPC action (panel buttons) and the `/bag` command action.
 */
import itemOp from "../rpc/item-op.js";
import openBag from "../rpc/open-bag.js";

export default function (covel) {
  covel.registerRpc("item-op", itemOp, {
    description: "Equip, unequip, or drop an inventory item (player action)",
  });
  covel.registerRpc("open-bag", openBag, {
    description: "Count carried items and open the inventory panel",
  });
}
