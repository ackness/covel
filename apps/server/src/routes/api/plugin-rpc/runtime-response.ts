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
  readonly dimensionConflict?: {
    readonly code: "dimension-version-conflict";
    readonly currentVersions: Readonly<Record<string, number>>;
  };
  readonly error?: string;
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
  // A turn is only "not committed" when proposals failed — a failed snapshot no
  // longer flips `committed`, so this is reached solely on proposal failure.
  if (outcome.failedProposalCount > 0) {
    return `${outcome.failedProposalCount} proposal(s) failed to commit`;
  }
  return "turn did not commit";
}

export interface FollowerRuntimeJobResult {
  readonly jobStatus: "done" | "failed";
  readonly runtimeStatus: "success" | "failed" | "skipped";
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
    !args.followerResult ||
    args.followerResult?.status === "failed" ||
    Boolean(args.followerResult?.error) ||
    // Only the handler envelope marks an intentional no-op. Framework gates
    // (dependency/setup/guard) must retain their failed-job signal.
    (args.followerResult?.status === "skipped" &&
      outputRecord.outcome !== "skipped");
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
        : !args.followerResult
          ? "deferred follower produced no result"
          : isFailure
            ? "runtime reported failure"
            : undefined);

  return {
    jobStatus: isFailure ? "failed" : "done",
    runtimeStatus: isFailure
      ? "failed"
      : args.followerResult?.status === "skipped"
        ? "skipped"
        : "success",
    durationMs: args.followerResult?.durationMs ?? args.turnDurationMs,
    ...(error ? { error } : {}),
    output: args.followerResult?.output ?? outputRecord,
  };
}
