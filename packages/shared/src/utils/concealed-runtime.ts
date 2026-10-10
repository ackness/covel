/**
 * Concealed runtimes (`io.concealed: true`) handle content that must stay
 * hidden from the player, such as hidden story events planned during play.
 * Their traces and execution history keep identity, status, timing, and usage
 * but never the prompts, tool arguments, tool results, or outputs.
 */

import type { RuntimeResult } from "../types/execution.js";
import type { RuntimeManifest } from "../types/plugin.js";

/** Trace payload fields that describe an execution without carrying content. */
const CONTENT_FREE_TRACE_FIELDS = new Set([
  "flowId",
  "seq",
  "runtimeId",
  "pluginId",
  "turnId",
  "runId",
  "status",
  "durationMs",
  "attempt",
  "finishReason",
  "usage",
  "slot",
  "model",
  "startedAt",
  "queueWaitMs",
  "maxOutputTokens",
  "toolName",
  "toolCallId",
  "label",
  "approvalStatus",
  "source",
  "success",
  "event",
  "hookName",
  "targetType",
  "targetId",
  "sourceTurnId",
  "runtimeIds",
  "sourceCommitted",
  "sourceFailedRuntimeIds",
]);

/** Keep only content-free fields of a concealed runtime's trace payload. */
export function concealTracePayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const kept: Record<string, unknown> = { concealed: true };
  for (const [key, value] of Object.entries(payload))
    if (CONTENT_FREE_TRACE_FIELDS.has(key)) kept[key] = value;
  return kept;
}

/** Failure text a player sees for a concealed runtime; the real one goes to the server log. */
export const CONCEALED_FAILURE_MESSAGE =
  "Runtime failed (details withheld for a concealed runtime)";

/** Strip a concealed runtime's outputs, tool payloads, and proposals. */
export function concealRuntimeResult(result: RuntimeResult): RuntimeResult {
  const {
    effects: _effects,
    pendingProposals: _pendingProposals,
    canonicalValue: _canonicalValue,
    ...rest
  } = result;
  return {
    ...rest,
    ...(rest.error === undefined ? {} : { error: CONCEALED_FAILURE_MESSAGE }),
    output: null,
    toolCalls: result.toolCalls.map((call) => ({
      ...call,
      input: null,
      output: null,
    })),
  };
}

/** IDs of the runtimes in `runtimes` that declare `io.concealed`. */
export function concealedRuntimeIds(
  runtimes: readonly RuntimeManifest[],
): ReadonlySet<string> {
  return new Set(
    runtimes
      .filter((runtime) => runtime.concealed)
      .map((runtime) => runtime.name),
  );
}
