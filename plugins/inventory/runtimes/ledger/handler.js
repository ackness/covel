import {
  actingCharacterOf,
  getPendingProposals,
  getToolContent,
  withPendingProposals,
} from "@covel/plugin-handlers-utils";

import { unappliedInventoryChanges } from "../../lib/applied-operations.js";
import updateInventory from "../../lib/update-inventory.js";
import {
  MAX_CHANGES,
  inventoryChangesFromWorldIR,
} from "../../lib/world-ir.js";

/**
 * Apply this turn's player inventory changes from the shared WorldIR
 * extraction, without a model call.
 *
 * @type {import("@covel/plugin-handlers-utils").PluginFunctionHandler}
 */
export default async function handler(ctx) {
  const player = actingCharacterOf(
    ctx.playerActions ?? [],
    ctx.world?.characters ?? [],
    ctx.world?.seats ?? [],
  );
  const { changes: all, alreadyApplied } = unappliedInventoryChanges(
    inventoryChangesFromWorldIR(ctx.inputs?.worldIR?.value, player),
    ctx.inputs?.operations?.value?.operations,
  );
  const appliedNotice = alreadyApplied > 0 ? { alreadyApplied } : {};
  const changes = all.slice(0, MAX_CHANGES);
  const notRecorded = all.length - changes.length;
  if (!changes.length)
    return {
      outcome: "success",
      value: { applied: 0, skipped: 0, results: [], ...appliedNotice },
    };
  const result = await updateInventory({ changes }, ctx);
  return withPendingProposals(
    {
      outcome: "success",
      value: {
        ...getToolContent(result),
        ...appliedNotice,
        ...(notRecorded > 0 && {
          notRecorded,
          note: `${notRecorded} item change(s) were not recorded: a turn records at most ${MAX_CHANGES}.`,
        }),
      },
    },
    getPendingProposals(result),
  );
}
