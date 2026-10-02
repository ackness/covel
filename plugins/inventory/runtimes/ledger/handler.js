import {
  getPendingProposals,
  getToolContent,
  shortIdBatch,
  withPendingProposals,
} from "@covel/plugin-handlers-utils";
import { z } from "zod";

import createUpdateInventory from "../../lib/update-inventory.js";
import { inventoryChangesFromWorldIR } from "../../lib/world-ir.js";

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
  const changes = inventoryChangesFromWorldIR(
    ctx.inputs?.worldIR?.value,
    player,
  );
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
    { outcome: "success", value: getToolContent(result) },
    getPendingProposals(result),
  );
}
