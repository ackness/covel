import { toJsonValueOrDiagnostic } from "@covel/shared";
import type {
  LLMTargetIdentity,
  RuntimeManifest,
  RuntimeResult,
} from "@covel/shared";
import type { SuspensionRecord } from "@covel/store";
import type { ExecutedToolCallState } from "../turn-executor/turn-output-helpers.js";

export type BusinessCalls = NonNullable<
  SuspensionRecord["pendingContinuation"]["businessCalls"]
>;

export function captureBusinessCalls(
  calls: readonly ExecutedToolCallState[],
): BusinessCalls {
  // A refused call is neither work done nor a failure left to resolve.
  return calls
    .filter((call) => !call.refused && isBusinessTool(call.name))
    .map((call) => ({
      name: call.name,
      success: call.success,
      result: toJsonValueOrDiagnostic(call.result ?? null, "business result"),
    }));
}

/** Successful executor-owned calls, including calls restored from a continuation. */
export function hasBusinessWork(
  manifest: RuntimeManifest,
  calls: readonly ExecutedToolCallState[],
): boolean {
  return calls.some(
    (call) => !call.refused && countsAsBusinessWork(manifest, call),
  );
}

function countsAsBusinessWork(
  manifest: RuntimeManifest,
  call: { name: string; success: boolean },
): boolean {
  return (
    call.success &&
    isBusinessTool(call.name) &&
    (!manifest.completeAfterTools?.length ||
      manifest.completeAfterTools.includes(call.name))
  );
}

/** Tools whose last attempt before a suspension failed, in first-failure order. */
export function unresolvedToolFailures(
  prior: readonly { name: string; success: boolean; refused?: boolean }[] = [],
): readonly string[] {
  const failures = new Set<string>();
  for (const call of prior) {
    if (call.refused || !isBusinessTool(call.name)) continue;
    if (call.success) failures.delete(call.name);
    else failures.add(call.name);
  }
  return [...failures];
}

/** Shared by initial execution and resume; model claims are not execution proof. */
export function completionContractError(
  manifest: RuntimeManifest,
  state: { requiredToolUseUnmet: boolean },
): string | undefined {
  if (state.requiredToolUseUnmet) {
    return `${manifest.name} declares requireToolUse but finished without a successful required business tool call (when afterTools is absent, any business tool counts; failed calls and host controls do not count).`;
  }
}

/** Keep response-validation failures attributable after the provider returned. */
export function withAgentFailureTarget(
  result: RuntimeResult,
  target: LLMTargetIdentity | undefined,
): RuntimeResult {
  if (
    result.status !== "failed" ||
    !result.error ||
    !target ||
    result.error.startsWith("[provider:")
  ) {
    return result;
  }
  return {
    ...result,
    error: `[provider: ${target.provider}, model: ${target.model}] ${result.error}`,
  };
}

/** Host controls never satisfy or poison business-work evidence. */
export function isBusinessTool(name: string): boolean {
  return ![
    "submit-output",
    "search-tools",
    "suspend",
    "delegate",
    "delegate-batch",
  ].includes(name);
}
