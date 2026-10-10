/**
 * Player-facing views of execution history for runtimes declared
 * `io.concealed`. Persisted rows keep full detail for retries; responses strip
 * the content before it leaves the server.
 */

import {
  CONCEALED_FAILURE_MESSAGE,
  concealedRuntimeIds,
  concealRuntimeResult,
  type RuntimeResult,
} from "@covel/shared";
import type { PluginRegistry } from "@covel/plugin-loader";
import type { RuntimeOutputRecord, TurnResultRecord } from "@covel/store";

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

/** Drop the output and failure reason of concealed runtimes from an RPC result summary. */
export function concealResultSummaries<
  T extends { readonly runtimeId: string; readonly output: unknown },
>(results: readonly T[], concealed: ReadonlySet<string>): T[] {
  return results.map((result) =>
    concealed.has(result.runtimeId)
      ? {
          ...result,
          output: null,
          ...("error" in result ? { error: CONCEALED_FAILURE_MESSAGE } : {}),
        }
      : result,
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

/** Strip a concealed runtime's output text and tool payloads from its row. */
export function concealRuntimeOutputRecord(
  record: RuntimeOutputRecord,
  concealed: ReadonlySet<string>,
): RuntimeOutputRecord {
  if (!concealed.has(record.runtimeId)) return record;
  const metaData =
    record.metaData && typeof record.metaData === "object"
      ? (record.metaData as Record<string, unknown>)
      : {};
  const toolCallList = metaData["toolCallList"];
  return {
    ...record,
    results: [],
    metaData: {
      ...metaData,
      ...(Array.isArray(toolCallList)
        ? {
            toolCallList: toolCallList.map((call: unknown) => ({
              ...(call as Record<string, unknown>),
              input: null,
              output: null,
            })),
          }
        : {}),
    },
  };
}
