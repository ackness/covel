/**
 * Player-facing views of execution history for runtimes declared
 * `io.concealed`. Persisted rows keep full detail for retries; responses strip
 * the content before it leaves the server.
 */

import {
  concealedRuntimeIds,
  concealRuntimeResult,
  type RuntimeResult,
} from "@covel/shared";
import type { PluginRegistry } from "@covel/plugin-loader";
import type { TurnResultRecord } from "@covel/store";

/** Every registered concealed runtime, including ones no longer active. */
export function registeredConcealedRuntimeIds(
  registry: PluginRegistry,
): ReadonlySet<string> {
  return concealedRuntimeIds(
    [...registry.getAll().values()].flatMap((entry) =>
      (entry.manifests ?? []).map((parsed) => parsed.manifest),
    ),
  );
}

function isRuntimeResult(value: unknown): value is RuntimeResult {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { runtimeId?: unknown }).runtimeId === "string"
  );
}

/** Drop the output of concealed runtimes from an RPC result summary. */
export function concealResultSummaries<
  T extends { readonly runtimeId: string; readonly output: unknown },
>(results: readonly T[], concealed: ReadonlySet<string>): T[] {
  return results.map((result) =>
    concealed.has(result.runtimeId) ? { ...result, output: null } : result,
  );
}

export function concealTurnResultRecord(
  record: TurnResultRecord,
  concealed: ReadonlySet<string>,
): TurnResultRecord {
  if (!concealed.size) return record;
  const conceal = (value: unknown): unknown =>
    isRuntimeResult(value) && concealed.has(value.runtimeId)
      ? concealRuntimeResult(value)
      : value;
  return {
    ...record,
    runtimeResults: Array.isArray(record.runtimeResults)
      ? record.runtimeResults.map(conceal)
      : record.runtimeResults,
    ...(record.auditResult === undefined
      ? {}
      : { auditResult: conceal(record.auditResult) }),
  };
}
