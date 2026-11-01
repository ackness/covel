import type {
  LLMTargetIdentity,
  RuntimeManifest,
  RuntimeResult,
} from "@covel/shared";
import type { SuspensionRecord } from "@covel/store";
import type { ExecutedToolCallState } from "../turn-executor/turn-output-helpers.js";

export type CompletionCalls = NonNullable<
  SuspensionRecord["pendingContinuation"]["completionCalls"]
>;

export function captureCompletionCalls(
  calls: readonly ExecutedToolCallState[],
  prior: CompletionCalls = [],
): CompletionCalls {
  return [
    ...prior,
    // A refused call is neither work done nor a failure left to resolve.
    ...calls
      .filter((call) => !call.refused && isBusinessTool(call.name))
      .map((call) => ({
        name: call.name,
        success: call.success,
        done: false,
      })),
  ];
}

/**
 * Whether the calls recorded before a suspension include business work. Only a
 * call that succeeded counts: a failed call also leaves a name in the
 * transcript, and host controls do not count.
 */
export function hasCompletedBusinessWork(
  manifest: RuntimeManifest,
  prior: CompletionCalls = [],
): boolean {
  return prior.some((call) => countsAsBusinessWork(manifest, call));
}

/**
 * Whether this loop has business work to show: a call that succeeded here, or
 * one that succeeded before the suspension it resumed from. A call in the
 * transcript proves nothing, since a failed call is recorded there as well.
 * The loop judges `requireToolUse` with this where it returns, so the answer
 * is the same however the loop ended.
 */
export function hasBusinessWork(
  manifest: RuntimeManifest,
  calls: readonly ExecutedToolCallState[],
  seededBusinessWork: boolean,
): boolean {
  return (
    seededBusinessWork ||
    calls.some((call) => countsAsBusinessWork(manifest, call))
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
  prior: CompletionCalls = [],
): readonly string[] {
  const failures = new Set<string>();
  for (const call of prior) {
    if (!isBusinessTool(call.name)) continue;
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
