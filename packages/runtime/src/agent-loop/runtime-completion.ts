import type { RuntimeManifest } from "@covel/shared";
import { isDefaultLocale } from "@covel/shared";
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
    return `${manifest.name} declares requireToolUse but finished without calling a business tool (a bare \`runtime-done\` does not count). The model answered with prose instead of doing the work.`;
  }
  if (state.requiredCompletionUnmet) {
    return `${manifest.name} declares requireExplicitCompletion but did not successfully complete a declared finishing tool or call runtime-done without unresolved tool failures.`;
  }
}

export function completionCorrection(
  manifest: RuntimeManifest,
  locale?: string,
): string {
  if (manifest.requireExplicitCompletion && !manifest.requireToolUse) {
    const tools = (manifest.completeAfterTools ?? []).join(", ");
    return isDefaultLocale(locale)
      ? `你尚未提交结果。有明确变化时调用完成工具（${tools}）；确实无变化时调用 runtime-done。纯文本、JSON 声明和查询工具不能代替提交；不要编造变化。`
      : `You have not submitted a result. For confirmed changes call a completing tool (${tools}); if nothing changed call runtime-done. Prose, JSON claims, and read tools do not complete the task. Do not invent changes.`;
  }
  return isDefaultLocale(locale)
    ? "你没有调用任何工具就结束了。必须先调用声明的工具完成任务，再收尾。"
    : "You finished without calling any tool. Call the declared tools to complete the task first, then wrap up.";
}

/** One bounded corrective step, shared by fresh and resumed tool loops. */
export function checkTextCompletion(args: {
  manifest: RuntimeManifest;
  calls: readonly ExecutedToolCallState[];
  seededBusinessWork: boolean;
  corrections: number;
  locale?: string;
  prior?: CompletionCalls;
}): { correction?: string; requiredToolUseUnmet: boolean } {
  const { manifest, calls } = args;
  const businessWork =
    args.seededBusinessWork ||
    calls.some((call) => call.success && !isRuntimeDoneSentinel(call.result));
  const requiredToolUseUnmet =
    manifest.requireToolUse === true && !businessWork;
  const explicitUnmet =
    manifest.requireExplicitCompletion &&
    !hasExplicitCompletion(manifest, calls, args.prior);
  if (!requiredToolUseUnmet && !explicitUnmet)
    return { requiredToolUseUnmet: false };
  const reason = requiredToolUseUnmet
    ? "no-tool-call"
    : "no-explicit-completion";
  if (args.corrections === 0) {
    console.warn(
      `[covel:warn] [runtime-retry] ${manifest.name} attempt=1 reason=${reason} cause=completion contract unmet`,
    );
    return {
      correction: completionCorrection(manifest, args.locale),
      requiredToolUseUnmet: false,
    };
  }
  console.warn(
    `[covel:warn] [runtime-retry] ${manifest.name} reason=${reason} cause=completion contract still unmet after correction; releasing`,
  );
  return { requiredToolUseUnmet };
}
