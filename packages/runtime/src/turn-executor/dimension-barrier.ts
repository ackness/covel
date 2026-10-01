import {
  DIMENSION_CONTRACT,
  DIMENSION_SETTLEMENT_NAMESPACE,
  dimensionSettlementReceiptSchema,
  type RuntimeManifest,
} from "@covel/shared";
import type { DataStore } from "@covel/store";

export async function dimensionExecutionBarrier(args: {
  readonly store?: DataStore;
  readonly sessionId: string;
  readonly runtimes: readonly RuntimeManifest[];
  readonly willNarrate: boolean;
}): Promise<string | undefined> {
  if (!args.store) return undefined;
  const providers = [
    ...new Set(
      args.runtimes
        .filter((runtime) => runtime.outputContract === DIMENSION_CONTRACT)
        .map((runtime) => runtime.pluginId),
    ),
  ];
  if (providers.length > 1) return "Conflicting dimension providers";
  const session = await args.store.getSession(args.sessionId);
  const bound = session?.metadata?._dimensionProviderPluginId;
  if (bound !== undefined && bound !== providers[0])
    return "Dimension provider unavailable; restore it before continuing";
  if (!args.willNarrate || !providers[0]) return undefined;
  const rows = await args.store.listPluginData(
    args.sessionId,
    providers[0],
    DIMENSION_SETTLEMENT_NAMESPACE,
  );
  const pending = rows
    .map((row) => dimensionSettlementReceiptSchema.parse(row.value))
    .find((receipt) => receipt.status === "pending-settlement");
  return pending
    ? `Dimension settlement pending for narrative ${pending.source.resultId}. Retry, resolve manually, or explicitly skip before continuing.`
    : undefined;
}
