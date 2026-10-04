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
    ...calls.map((call) => ({
      name: call.name,
      success: call.success,
      done: call.name === "runtime-done" && isRuntimeDoneSentinel(call.result),
    })),
  ];
}

/**
 * Whether the calls recorded before a suspension include business work. Only a
 * call that succeeded counts: a failed call also leaves a name in the
 * transcript, and `runtime-done` records nothing.
 */
export function hasCompletedBusinessWork(prior: CompletionCalls = []): boolean {
  return prior.some((call) => call.success && !call.done);
}

/**
 * Whether this loop has business work to show: a call that succeeded here, or
 * one that succeeded before the suspension it resumed from. A call in the
 * transcript proves nothing, since a failed call is recorded there as well.
 * The loop judges `requireToolUse` with this where it returns, so the answer
 * is the same however the loop ended.
 */
export function hasBusinessWork(
  calls: readonly ExecutedToolCallState[],
  seededBusinessWork: boolean,
): boolean {
  return (
    seededBusinessWork ||
    calls.some((call) => call.success && !isRuntimeDoneSentinel(call.result))
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

export function hasExplicitCompletion(
  manifest: RuntimeManifest,
  calls: readonly ExecutedToolCallState[],
  prior?: CompletionCalls,
): boolean {
  // A later successful invocation of the same tool resolves its failed attempt
  // (including corrected arguments). Other tools and runtime-done do not.
  const failures = new Set<string>();
  const completions = captureCompletionCalls(calls, prior);
  for (const call of completions) {
    if (call.success) failures.delete(call.name);
    else failures.add(call.name);
  }
  return (
    failures.size === 0 &&
    completions.some(
      (call) =>
        call.success &&
        (manifest.completeAfterTools?.includes(call.name) || call.done),
    )
  );
}

/** Shared by initial execution and resume; model claims are not execution proof. */
export function completionContractError(
  manifest: RuntimeManifest,
  state: { requiredToolUseUnmet: boolean; requiredCompletionUnmet: boolean },
): string | undefined {
  if (state.requiredToolUseUnmet) {
    return `${manifest.name} declares requireToolUse but finished without a business tool call that succeeded (a failed call and a bare \`runtime-done\` do not count).`;
  }
  if (state.requiredCompletionUnmet) {
    return `${manifest.name} declares requireExplicitCompletion but did not successfully complete a declared finishing tool or call runtime-done without unresolved tool failures.`;
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
  if (manifest.requireExplicitCompletion && !manifest.requireToolUse) {
    const tools = (manifest.completeAfterTools ?? []).join(", ");
    return instructionLocaleFor(locale) === "zh"
      ? `你尚未提交结果。有明确变化时调用完成工具（${tools}）；确实无变化时调用 runtime-done。纯文本、JSON 声明和查询工具不能代替提交；不要编造变化。`
      : `You have not submitted a result. For confirmed changes call a completing tool (${tools}); if nothing changed call runtime-done. Prose, JSON claims, and read tools do not complete the task. Do not invent changes.`;
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
  corrections: number;
  locale?: string;
  prior?: CompletionCalls;
}): { correction?: string } {
  const { manifest, calls } = args;
  const requiredToolUseUnmet =
    manifest.requireToolUse === true &&
    !hasBusinessWork(calls, args.seededBusinessWork);
  const explicitUnmet =
    manifest.requireExplicitCompletion &&
    !hasExplicitCompletion(manifest, calls, args.prior);
  if (!requiredToolUseUnmet && !explicitUnmet) return {};
  const reason = requiredToolUseUnmet
    ? "no-tool-call"
    : "no-explicit-completion";
  if (args.corrections === 0) {
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
