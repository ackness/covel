/**
 * Unified server entry (PLUGIN.md `entry`) — registers the player-side
 * item-op RPC action (panel buttons) and the `/bag` command action, and puts
 * what the player carries into the session summary.
 */
import { appendSummaryEntries, labelText } from "@covel/plugin-handlers-utils";
import itemOp from "../rpc/item-op.js";
import openBag from "../rpc/open-bag.js";

/** The summary is a glance; the panel has the whole bag. */
const SUMMARY_ITEMS = 8;

export default function (covel) {
  covel.registerRpc("item-op", itemOp, {
    description: "Equip, unequip, or drop an inventory item (player action)",
  });
  covel.registerRpc("open-bag", openBag, {
    description: "Count carried items and open the inventory panel",
  });
  covel.provideExtension("ui.slot@1", "summary", {
    async handler({ previous }, ctx) {
      const carried = (await ctx.pluginData.list("items"))
        .map((row) => row.value)
        .filter(
          (item) =>
            item &&
            typeof item.name === "string" &&
            item.removed !== true &&
            Number(item.quantity) > 0,
        )
        // Worn or held gear first, then whatever changed most recently.
        .sort(
          (a, b) =>
            Number(b.equipped === true) - Number(a.equipped === true) ||
            String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")),
        );
      if (carried.length === 0) return appendSummaryEntries(previous, []);
      return appendSummaryEntries(previous, [
        {
          id: "inventory.items",
          kind: "list",
          label: labelText(ctx, "Pack"),
          items: carried
            .slice(0, SUMMARY_ITEMS)
            .map((item) =>
              item.quantity > 1 ? `${item.name} ×${item.quantity}` : item.name,
            ),
          total: carried.length,
        },
      ]);
    },
  });
}
