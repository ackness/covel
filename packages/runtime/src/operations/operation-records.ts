/**
 * Operation records: the persisted account of each write-service call
 * (`OperationRecord` in `@covel/shared`), built when a run's operations are
 * put on its result and settled at commit.
 *
 * `request`, `result` and `summary` are what a model may read later, so they
 * pass through `modelFacingJson`: no row IDs, UUIDs or timestamps.
 */

import {
  modelFacingJson,
  toJsonValueOrDiagnostic,
  type JsonValue,
  type OperationFailureReason,
  type OperationRecord,
  type OperationStatus,
  type RuntimeResult,
} from "@covel/shared";
import type { StagedOperation } from "./operation-stage.js";

/** Largest `request` or `result` kept on a record, as JSON. */
export const OPERATION_PAYLOAD_MAX_BYTES = 4 * 1024;
/** Longest `summary`. */
export const OPERATION_SUMMARY_MAX_CHARS = 300;

function modelView(value: unknown): JsonValue | undefined {
  const json = toJsonValueOrDiagnostic(value, "operation");
  const view = modelFacingJson(json);
  return view === undefined ? undefined : (view as JsonValue);
}

function fits(value: JsonValue | undefined): boolean {
  return (
    value === undefined ||
    new TextEncoder().encode(JSON.stringify(value)).byteLength <=
      OPERATION_PAYLOAD_MAX_BYTES
  );
}

export function buildOperationRecord(
  operation: StagedOperation,
  state: {
    readonly status: OperationStatus;
    readonly reason?: OperationFailureReason;
  },
): OperationRecord {
  const request = modelView(operation.request);
  const result = modelView(operation.result);
  const keepRequest = fits(request);
  const keepResult = fits(result);
  const summary = JSON.stringify(
    modelFacingJson({
      ...(request !== undefined ? { request } : {}),
      ...(result !== undefined ? { result } : {}),
    }),
  ).slice(0, OPERATION_SUMMARY_MAX_CHARS);
  return {
    id: operation.id,
    contract: operation.contract,
    providerPluginId: operation.providerPluginId,
    service: operation.service,
    invokedBy: {
      pluginId: operation.invokedBy.pluginId,
      runtimeId: operation.invokedBy.runtimeId,
    },
    ...(operation.toolCallId !== undefined
      ? { toolCallId: operation.toolCallId }
      : {}),
    seq: operation.seq,
    status: state.status,
    ...(state.reason !== undefined ? { reason: state.reason } : {}),
    summary,
    ...(request !== undefined && keepRequest ? { request } : {}),
    ...(result !== undefined && keepResult ? { result } : {}),
    ...(!keepRequest || !keepResult ? { truncated: true as const } : {}),
  };
}

/** The operation records of `results`, in call order. */
export function operationRecordsOf(
  results: readonly Pick<RuntimeResult, "operations">[],
): OperationRecord[] {
  return results
    .flatMap((result) => result.operations ?? [])
    .sort((a, b) => a.seq - b.seq);
}
