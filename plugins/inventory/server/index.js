/**
 * Unified server entry (PLUGIN.md `entry`) — registers the player-side
 * item-op RPC action (panel buttons) and the `/bag` command action, and puts
 * what the player carries into the session summary. It also offers bag lookup
 * and atomic item exchanges through public services.
 */
import { compareText } from "@covel/plugin-handlers-utils";
import { appendSummaryEntries, labelText } from "@covel/plugin-handlers-utils";
import { bag, change } from "../lib/inventory-services.js";
import itemOp from "../rpc/item-op.js";
import openBag from "../rpc/open-bag.js";

/** The summary is a glance; the panel has the whole bag. */
const SUMMARY_ITEMS = 8;

export default function (covel) {
  const { z } = covel.toolkit;
  const item = z.string().trim().min(1).max(80);
  const quantity = z.number().int().min(1).max(999).optional();
  const changeInput = z.discriminatedUnion("op", [
    z
      .object({
        op: z.literal("add"),
        item,
        quantity,
        description: z.string().max(200).optional(),
        tags: z.array(z.string()).max(5).optional(),
      })
      .strict(),
    z.object({ op: z.literal("remove"), item, quantity }).strict(),
    z.object({ op: z.literal("equip"), item }).strict(),
    z.object({ op: z.literal("unequip"), item }).strict(),
  ]);
  covel.registerService({
    name: "bag",
    contract: "inventory.bag@1",
    modelFacing: true,
    description:
      "Look up what the player character carries now. Optionally filter by a name or tag; equipped items come first. Returns at most 50 items and the full matching count.",
    input: z.object({ query: z.string().max(80).optional() }),
    output: z.object({
      items: z.array(
        z.object({
          name: z.string(),
          quantity: z.number(),
          equipped: z.boolean(),
          tags: z.array(z.string()),
          description: z.string().optional(),
        }),
      ),
      total: z.number().int(),
    }),
    handler: bag,
  });
  covel.registerService({
    name: "change",
    contract: "inventory.change@1",
    access: "write",
    modelFacing: true,
    description:
      "Change items moving now in the story: buying, selling, giving, receiving, equipping, unequipping, or using up. Remove the payment first; money is an item tagged as currency. Read the bag first when unsure of names. The whole exchange is refused if any removal cannot be afforded or equipment is not held.",
    input: z.object({ changes: z.array(changeInput).min(1).max(8) }),
    output: z.object({
      results: z.array(
        z.object({
          op: z.enum(["add", "remove", "equip", "unequip"]),
          item: z.string(),
          status: z.enum(["created", "updated", "removed", "skipped"]),
          quantity: z.number().optional(),
        }),
      ),
    }),
    handler: change,
  });
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
            compareText(String(b.updatedAt ?? ""), String(a.updatedAt ?? "")),
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
