import type { PluginRpcRuntimeResultSummary } from "@covel/shared";

/**
 * Authoritative outcome of a turn's commit phase. A runtime can report
 * `success` while its proposals fail to land — every caller that reports
 * completion (RPC response, background job status, deferred scheduling) must
 * consume this rather than runtime status alone.
 */
export interface TurnCommitOutcome {
  readonly committed: boolean;
  readonly failedProposalCount: number;
  readonly snapshotFailed: boolean;
}

export interface ManualTurnSummary {
  readonly commit: TurnCommitOutcome;
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
  summary: Pick<ManualTurnSummary, "runtimeResults" | "commit">,
): BackgroundJobCompletion {
  const failedResult = summary.runtimeResults.find(
    (result) => result.status === "failed",
  );
  if (failedResult) {
    return {
      status: "failed",
      error: failedResult.error ?? "runtime reported failure",
    };
  }
  if (!summary.commit.committed) {
    return { status: "failed", error: commitFailureMessage(summary.commit) };
  }
  return { status: "done" };
}

export function commitFailureMessage(outcome: TurnCommitOutcome): string {
  if (outcome.failedProposalCount > 0) {
    return `${outcome.failedProposalCount} proposal(s) failed to commit`;
  }
  if (outcome.snapshotFailed) return "auto-snapshot failed after commit";
  return "turn did not commit";
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
  readonly commit: TurnCommitOutcome;
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
  const isFailure =
    executorReportedFailure || handlerSaysFailed || !args.commit.committed;
  const error =
    args.followerResult?.error ??
    (handlerSaysFailed && typeof outputRecord.error === "string"
      ? outputRecord.error
      : !args.commit.committed
        ? commitFailureMessage(args.commit)
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
