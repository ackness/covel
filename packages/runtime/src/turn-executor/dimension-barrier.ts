import {
  DIMENSION_CONTRACT,
  DIMENSION_SETTLEMENT_NAMESPACE,
  dimensionSettlementReceiptSchema,
  type DimensionSettlementReceipt,
  type RuntimeManifest,
} from "@covel/shared";
import type { DataStore } from "@covel/store";

/** How the executor marks a story held back because the provider did not publish. */
export const DIMENSION_SNAPSHOT_SKIP = {
  reason: "dimension-snapshot-unavailable",
  by: "framework:dimensionSnapshot",
} as const;

export function isDimensionSnapshotSkip(result: {
  readonly status: string;
  readonly output?: unknown;
}): boolean {
  const output = result.output as { skippedBy?: unknown } | null | undefined;
  return (
    result.status === "skipped" &&
    output?.skippedBy === DIMENSION_SNAPSHOT_SKIP.by
  );
}

/** The session's unsettled narratives, oldest first, with their provider. */
export async function pendingDimensionSettlements(args: {
  readonly store: DataStore;
  readonly sessionId: string;
  readonly runtimes: readonly RuntimeManifest[];
}): Promise<
  | {
      readonly providerPluginId: string;
      readonly receipts: readonly DimensionSettlementReceipt[];
    }
  | undefined
> {
  const providers = [
    ...new Set(
      args.runtimes
        .filter((runtime) => runtime.outputContract === DIMENSION_CONTRACT)
        .map((runtime) => runtime.pluginId),
    ),
  ];
  const providerPluginId = providers[0];
  if (providers.length !== 1 || !providerPluginId) return undefined;
  const rows = await args.store.queryPluginData({
    sessionId: args.sessionId,
    pluginId: providerPluginId,
    namespace: DIMENSION_SETTLEMENT_NAMESPACE,
    valueFilter: { field: "status", values: ["pending-settlement"] },
  });
  const receipts = rows
    .filter((row) => {
      const value = row.value as { status?: unknown } | null;
      return value?.status === "pending-settlement";
    })
    .map((row) => dimensionSettlementReceiptSchema.parse(row.value))
    .sort((a, b) => a.source.turnNumber - b.source.turnNumber);
  return { providerPluginId, receipts };
}

/** Why a turn cannot run with several plugins publishing world dimensions. */
export function dimensionProviderConflictReason(
  providers: readonly string[],
): string {
  return `Several plugins keep world dimensions (${providers.join(", ")}). Turn all but one of them off, then send your message again.`;
}

/**
 * Whether the execution may run. A bound provider that is not running only
 * pauses the dimensions: the story goes on, no runtime can write them (the
 * commit refuses every writer but the bound provider), and they keep their
 * values until it is back. Several providers, or another one taking the bound
 * provider's place, stop the execution with a reason the player can act on.
 */
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
  if (providers.length > 1) return dimensionProviderConflictReason(providers);
  const provider = providers[0];
  // No provider runs: nothing writes the dimensions, and no settlement can run.
  if (!provider) return undefined;
  const session = await args.store.getSession(args.sessionId);
  const bound = session?.metadata?._dimensionProviderPluginId;
  if (bound !== undefined && bound !== provider)
    return `This session's dimensions belong to "${String(bound)}", which is not running. "${provider}" also keeps world dimensions and cannot take them over: turn it off to play on without dimension updates.`;
  if (!args.willNarrate) return undefined;
  const pending = (
    await pendingDimensionSettlements({
      store: args.store,
      sessionId: args.sessionId,
      runtimes: args.runtimes,
    })
  )?.receipts[0];
  // The host retries the settlement before a turn reaches this point, so the
  // player reads this only when that retry failed too.
  return pending
    ? `The world state of turn ${pending.source.turnNumber} is not settled, and the automatic retry did not settle it. Use Retry in the pending settlement notice (or Skip to continue without it), then send your message again.${pending.error ? ` Last error: ${pending.error}` : ""}`
    : undefined;
}
