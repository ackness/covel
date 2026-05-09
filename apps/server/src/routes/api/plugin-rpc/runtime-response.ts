import type { PluginRpcRuntimeResultSummary } from "@covel/shared";

export interface ManualTurnSummary {
  readonly turnId: string;
  readonly runtimeResults: readonly PluginRpcRuntimeResultSummary[];
  readonly durationMs: number;
  readonly abortReason?: string;
  readonly deferredFollowers: ReadonlyArray<{
    readonly runtimeId: string;
    readonly pluginId: string;
    readonly triggerEvent: {
      readonly topic: string;
      readonly data: Readonly<Record<string, unknown>>;
    };
  }>;
}

export interface BackgroundJobCompletion {
  readonly status: "done" | "failed";
  readonly error?: string;
}

export function deriveBackgroundJobCompletion(
  summary: Pick<ManualTurnSummary, "runtimeResults">,
): BackgroundJobCompletion {
  const failedResult = summary.runtimeResults.find(
    (result) => result.status === "failed",
  );
  if (!failedResult) return { status: "done" };
  return {
    status: "failed",
    error: failedResult.error ?? "runtime reported failure",
  };
}

export interface FollowerRuntimeJobResult {
  readonly jobStatus: "done" | "failed";
  readonly runtimeStatus: "success" | "failed";
  readonly durationMs: number;
  readonly error?: string;
  readonly output: unknown;
}

export function deriveFollowerRuntimeJobResult(args: {
  readonly followerResult?: PluginRpcRuntimeResultSummary;
  readonly turnDurationMs: number;
}): FollowerRuntimeJobResult {
  const outputRecord = (args.followerResult?.output ?? {}) as Record<
    string,
    unknown
  >;
  const executorReportedFailure =
    args.followerResult?.status === "failed" ||
    args.followerResult?.status === "skipped";
  const handlerSaysFailed =
    outputRecord.status === "failed" ||
    (typeof outputRecord.error === "string" && outputRecord.error.length > 0);
  const isFailure = executorReportedFailure || handlerSaysFailed;
  const error =
    args.followerResult?.error ??
    (handlerSaysFailed && typeof outputRecord.error === "string"
      ? outputRecord.error
      : isFailure
        ? "runtime reported failure"
        : undefined);

  return {
    jobStatus: isFailure ? "failed" : "done",
    runtimeStatus: isFailure ? "failed" : "success",
    durationMs: args.followerResult?.durationMs ?? args.turnDurationMs,
    ...(error ? { error } : {}),
    output: args.followerResult?.output ?? outputRecord,
  };
}
