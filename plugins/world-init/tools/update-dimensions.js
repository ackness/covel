import {
  makeProposal,
  withPendingProposals,
} from "@covel/plugin-handlers-utils";
import {
  DIMENSION_DATA_NAMESPACE,
  DIMENSION_SETTLEMENT_NAMESPACE,
  dimensionRecordSchema,
  dimensionSettlementReceiptSchema,
  dimensionUpdatePayloadSchema,
  materializeDimensionRecords,
} from "@covel/shared";

/** The model supplies values, never the authoritative source or read set. */
export default function ({ tool, z }) {
  return tool({
    name: "update-dimensions",
    description:
      "Settle this narrative's dimension rules once. Submit a batch of {id, expectedVersion, value, reason}; submit updates: [] to explicitly settle no change. Values must match the declared schema. Never invent facts or copy character/inventory/time state.",
    parameters: z.strictObject({
      updates: z
        .array(
          z.strictObject({
            id: z.string().min(1),
            expectedVersion: z.number().int().positive(),
            value: z.unknown(),
            reason: z.string().max(2000).optional(),
          }),
        )
        .max(64),
    }),
    execute: async ({ updates }, ctx) => {
      const narrative = ctx.inputSlots?.narrative;
      if (
        narrative?.cardinality !== "one" ||
        typeof narrative.value !== "string"
      )
        throw new Error(
          "A successful authoritative narrative input is required",
        );
      const rows = await ctx.store.listPluginData(DIMENSION_DATA_NAMESPACE);
      const records = Object.fromEntries(
        rows.map((row) => [row.key, dimensionRecordSchema.parse(row.value)]),
      );
      const row = await ctx.store.getPluginData(
        DIMENSION_SETTLEMENT_NAMESPACE,
        narrative.source.resultId,
      );
      const receipt = row
        ? dimensionSettlementReceiptSchema.parse(row.value)
        : undefined;
      if (receipt && receipt.status !== "pending-settlement")
        return { success: true, alreadySettled: true };
      const session = await ctx.store.getSession();
      const source = receipt?.source ?? {
        resultId: narrative.source.resultId,
        turnNumber: session.completedPlayerTurns + 1,
      };
      const readVersions = Object.fromEntries(
        Object.entries(ctx.world.dimensions).map(([id, entry]) => [
          id,
          entry.version,
        ]),
      );
      const payload = dimensionUpdatePayloadSchema.parse({
        updates,
        source,
        readVersions,
        ...(updates.length === 0 ? { settlement: "no-change" } : {}),
      });
      const proposal = makeProposal(
        ctx,
        new Date().toISOString(),
        "dimension.update",
        payload,
      );
      materializeDimensionRecords(records, proposal);
      return withPendingProposals(
        { success: true, updateCount: updates.length },
        [proposal],
      );
    },
  });
}
