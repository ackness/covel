import {
  makeProposal,
  withPendingProposals,
} from "@covel/plugin-handlers-utils";
import {
  DIMENSION_DATA_NAMESPACE,
  DIMENSION_SETTLEMENT_NAMESPACE,
  dimensionRecordSchema,
  DimensionConflictError,
  dimensionSettlementReceiptSchema,
  dimensionUpdatePayloadSchema,
  materializeDimensionRecords,
} from "@covel/plugin-handlers-utils/dimensions";
import { z } from "zod";

const requestSchema = z.strictObject({
  updates: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        expectedVersion: z.number().int().positive(),
        value: z.unknown(),
      }),
    )
    .max(64),
  resultId: z.string().min(1).optional(),
  resolution: z.enum(["manual", "skipped"]).optional(),
});

export default async function handler(ctx) {
  const request = requestSchema.parse(ctx.manualPayload);
  if (Boolean(request.resultId) !== Boolean(request.resolution))
    throw new Error(
      "A source and explicit manual/skipped resolution are both required",
    );
  const rows = await ctx.store.listPluginData(DIMENSION_DATA_NAMESPACE);
  const records = Object.fromEntries(
    rows.map((row) => [row.key, dimensionRecordSchema.parse(row.value)]),
  );
  const receiptRow = request.resultId
    ? await ctx.store.getPluginData(
        DIMENSION_SETTLEMENT_NAMESPACE,
        request.resultId,
      )
    : null;
  const receipt = receiptRow
    ? dimensionSettlementReceiptSchema.parse(receiptRow.value)
    : undefined;
  if (request.resultId && !receipt)
    throw new Error("Unknown settlement source");
  if (receipt && receipt.status !== "pending-settlement")
    return { outcome: "success", value: { alreadySettled: true } };
  const payload = dimensionUpdatePayloadSchema.parse({
    updates: request.updates,
    ...(receipt
      ? {
          source: receipt.source,
          settlement: request.resolution,
          readVersions: Object.fromEntries(
            Object.entries(ctx.world.dimensions).map(([id, entry]) => [
              id,
              entry.version,
            ]),
          ),
        }
      : {}),
  });
  const proposal = makeProposal(
    ctx,
    new Date().toISOString(),
    "dimension.update",
    payload,
  );
  try {
    materializeDimensionRecords(records, proposal);
  } catch (error) {
    if (!(error instanceof DimensionConflictError)) throw error;
    return {
      outcome: "success",
      value: {
        applied: false,
        code: "dimension-version-conflict",
        currentVersions: Object.fromEntries(
          Object.entries(records).map(([id, record]) => [id, record.version]),
        ),
      },
    };
  }
  return withPendingProposals(
    { outcome: "success", value: { submitted: true } },
    [proposal],
  );
}
