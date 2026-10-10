import {
  getPendingProposals,
  getToolContent,
  shortIdBatch,
  withPendingProposals,
} from "@covel/plugin-handlers-utils";
import { z } from "zod";

import createUpdateInventory from "../../lib/update-inventory.js";
import {
  MAX_CHANGES,
  inventoryChangesFromWorldIR,
} from "../../lib/world-ir.js";

const updateInventory = createUpdateInventory({
  tool: (definition) => definition,
  z,
  shortIdBatch,
});

/**
 * Apply this turn's player inventory changes from the shared WorldIR
 * extraction, without a model call.
 *
 * @type {import("@covel/plugin-handlers-utils").PluginFunctionHandler}
 */
export default async function handler(ctx) {
  const player = ctx.world?.characters.find(
    (character) => character.type === "player",
  );
  const all = inventoryChangesFromWorldIR(ctx.inputs?.worldIR?.value, player);
  const changes = all.slice(0, MAX_CHANGES);
  const notRecorded = all.length - changes.length;
  if (!changes.length)
    return {
      outcome: "success",
      value: { applied: 0, skipped: 0, results: [] },
    };
  const result = await updateInventory.execute(
    updateInventory.parameters.parse({ changes }),
    ctx,
  );
  return withPendingProposals(
    {
      outcome: "success",
      value: {
        ...getToolContent(result),
        ...(notRecorded > 0 && {
          notRecorded,
          note: `${notRecorded} item change(s) were not recorded: a turn records at most ${MAX_CHANGES}.`,
        }),
      },
    },
    getPendingProposals(result),
  );
}
