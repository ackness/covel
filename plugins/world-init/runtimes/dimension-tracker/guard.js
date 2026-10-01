import {
  DIMENSION_DATA_NAMESPACE,
  DIMENSION_SETTLEMENT_NAMESPACE,
  dimensionRecordSchema,
  dimensionSettlementReceiptSchema,
  resolveI18nText,
} from "@covel/shared";

export default async function guard(ctx) {
  const source = ctx.inputs?.narrative?.source;
  const row = source
    ? await ctx.store.getPluginData(
        DIMENSION_SETTLEMENT_NAMESPACE,
        source.resultId,
      )
    : null;
  const receipt = row
    ? dimensionSettlementReceiptSchema.parse(row.value)
    : undefined;
  if (receipt && receipt.status !== "pending-settlement")
    return { skip: true, alreadySettled: true };
  if (receipt) return { skip: false };
  const rows = await ctx.store.listPluginData(DIMENSION_DATA_NAMESPACE);
  const active = rows.some((row) =>
    resolveI18nText(
      dimensionRecordSchema.parse(row.value).definition.updateRule,
      ctx.locale,
    )?.trim(),
  );
  return { skip: !active };
}
