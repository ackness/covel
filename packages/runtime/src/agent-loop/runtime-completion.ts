import { requiredAgentWork } from "@covel/shared/plugin-runtime";
import type {
  LLMTargetIdentity,
  RuntimeManifest,
  RuntimeResult,
} from "@covel/shared";
import { instructionLocaleFor } from "@covel/shared";
import { isRuntimeDoneSentinel } from "@covel/tools";
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
      .filter((call) => !call.refused)
      .map((call) => ({
        name: call.name,
        success: call.success,
        done:
          call.name === "runtime-done" && isRuntimeDoneSentinel(call.result),
      })),
  ];
}

/**
 * Whether the calls recorded before a suspension include business work. Only a
 * call that succeeded counts: a failed call also leaves a name in the
 * transcript, and `runtime-done` records nothing.
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
    ![
      "submit-output",
      "search-tools",
      "suspend",
      "delegate",
      "delegate-batch",
      "runtime-done",
    ].includes(call.name) &&
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

function completionCorrection(
  manifest: RuntimeManifest,
  locale?: string,
): string {
  if (manifest.requireToolUse && manifest.completeAfterTools?.length) {
    const tools = manifest.completeAfterTools.join(", ");
    return instructionLocaleFor(locale) === "zh"
      ? `尚未成功调用必需的业务工具（${tools}）。请先调用其中一个；无变化时也按工具说明提交空结果，然后调用 submit-output。其他工具不能代替此项工作。`
      : `No required business tool (${tools}) has succeeded. Use one of these tools, including an empty result when its description allows no change, then call submit-output. Other tools do not satisfy this prerequisite.`;
  }
  return instructionLocaleFor(locale) === "zh"
    ? "你没有调用任何工具就结束了。必须先调用声明的工具完成任务，再收尾。"
    : "You finished without calling any tool. Call the declared tools to complete the task first, then wrap up.";
}

/**
 * The correction for a `requireToolUse` runtime that called only
 * `runtime-done`: the terminator does not record anything, including "no
 * change".
 */
export function runtimeDoneCorrection(locale?: string): string {
  return instructionLocaleFor(locale) === "zh"
    ? "runtime-done 只结束运行，不会记录任何结果。请调用声明的业务工具提交本轮结果；确实无变化时也要按工具说明提交空结果，然后再结束。"
    : "runtime-done only ends the run; it records nothing. Call the declared business tool to submit this turn's result; if nothing changed, submit the empty result its description allows, then finish.";
}

/**
 * One bounded corrective step for a text answer, shared by fresh and resumed
 * tool loops. It only decides whether to ask the model again; whether the
 * contract was met is judged where the loop returns.
 */
export function checkTextCompletion(args: {
  manifest: RuntimeManifest;
  calls: readonly ExecutedToolCallState[];
  seededBusinessWork: boolean;
  canCorrect: () => boolean;
  locale?: string;
  prior?: CompletionCalls;
}): { correction?: string } {
  const { manifest, calls } = args;
  const requiredToolUseUnmet =
    requiredAgentWork(manifest).required &&
    !hasBusinessWork(manifest, calls, args.seededBusinessWork);
  if (!requiredToolUseUnmet) return {};
  const reason = "no-tool-call";
  if (args.canCorrect()) {
    console.warn(
      `[covel:warn] [runtime-retry] ${manifest.name} attempt=1 reason=${reason} cause=completion contract unmet`,
    );
    return { correction: completionCorrection(manifest, args.locale) };
  }
  console.warn(
    `[covel:warn] [runtime-retry] ${manifest.name} reason=${reason} cause=completion contract still unmet after correction; releasing`,
  );
  return {};
}
