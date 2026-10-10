import {
  makeProposal,
  withPendingProposals,
} from "@covel/plugin-handlers-utils";
import {
  applyDimensionDerivations,
  dimensionUpdatePayloadSchema,
  dimensionsJsonEqual,
} from "@covel/plugin-handlers-utils/dimensions";

/**
 * A derived value is a function of the clock, not of the value before it. A
 * turn that is run again, a session forked from an earlier turn, and a turn
 * after one in which this runtime did not run all get the value of their own
 * clock.
 *
 * It runs after the tracker, so the two never write one dimension from the
 * same version: the value read here already has the tracker's update, and
 * only the derived fields of it change.
 */
export default async function handler(ctx) {
  const elapsedSinceStart = ctx.inputs?.worldTime?.value?.elapsedSinceStart;
  // No clock in this session, or a turn that settled no time.
  if (!Number.isFinite(elapsedSinceStart))
    return { outcome: "success", value: { updated: [] } };
  const updates = [];
  for (const [id, entry] of Object.entries(ctx.world.dimensions)) {
    const value = applyDimensionDerivations(entry.schema, entry.value, {
      clock: { elapsedSinceStart },
    });
    if (!dimensionsJsonEqual(value, entry.value))
      updates.push({ id, expectedVersion: entry.version, value });
  }
  const result = {
    outcome: "success",
    value: { updated: updates.map((update) => update.id), elapsedSinceStart },
  };
  if (!updates.length) return result;
  return withPendingProposals(result, [
    makeProposal(
      ctx,
      new Date().toISOString(),
      "dimension.update",
      dimensionUpdatePayloadSchema.parse({ updates }),
    ),
  ]);
}
