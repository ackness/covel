import type { PluginRpcRuntimeResultSummary, TurnResult } from "@covel/shared";

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

/** Inside the commit transaction a rejected proposal has already rolled back. */
const IN_COMMIT: TurnCommitOutcome = {
  committed: true,
  failedProposalCount: 0,
  snapshotFailed: false,
};

function summarizeRuntimeResults(
  results: TurnResult["runtimeResults"],
): PluginRpcRuntimeResultSummary[] {
  return results.map((result) => ({
    runtimeId: result.runtimeId,
    pluginId: result.pluginId,
    status: result.status,
    durationMs: result.durationMs,
    ...(result.error ? { error: result.error } : {}),
    output: result.output,
  }));
}

export interface ActivatedRunSettlement {
  readonly failure?: {
    readonly reason: "runtime-reported-failure" | "follower-not-emitted";
    readonly error: string;
  };
  /** Background followers to queue in the same transaction. */
  readonly followers: ManualTurnSummary["deferredFollowers"];
  readonly runtimeResults: readonly PluginRpcRuntimeResultSummary[];
}

/**
 * Settle a queued manual or event activation from its execution result.
 * Followers chain only off a run that did not fail; a run that exists to
 * prepare a follower fails when it emitted none.
 */
export function settleActivatedRun(args: {
  readonly activation: "manual" | "event";
  readonly runtimeId: string;
  readonly turnResult: Pick<
    TurnResult,
    "runtimeResults" | "deferredFollowers" | "durationMs"
  >;
  readonly expectFollower?: boolean;
}): ActivatedRunSettlement {
  const runtimeResults = summarizeRuntimeResults(
    args.turnResult.runtimeResults,
  );
  const deferred = args.turnResult.deferredFollowers ?? [];
  if (args.expectFollower) {
    if (deferred.length > 0) return { followers: deferred, runtimeResults };
    const failed = runtimeResults.find((result) => result.status === "failed");
    return {
      failure: failed
        ? {
            reason: "runtime-reported-failure",
            error: failed.error ?? "runtime reported failure",
          }
        : {
            reason: "follower-not-emitted",
            error: `runtime "${args.runtimeId}" completed without emitting a matching background follower event`,
          },
      followers: [],
      runtimeResults,
    };
  }
  const target = runtimeResults.find(
    (result) => result.runtimeId === args.runtimeId,
  );
  const output = (target?.output ?? {}) as Record<string, unknown>;
  const error =
    args.activation === "manual"
      ? (deriveBackgroundJobCompletion({ runtimeResults, commit: IN_COMMIT })
          .error ??
        // A handler can report its own failure in a successful result.
        (output.status === "failed" ||
        (typeof output.error === "string" && output.error)
          ? typeof output.error === "string" && output.error
            ? output.error
            : "runtime reported failure"
          : undefined))
      : deriveFollowerRuntimeJobResult({
          followerResult: target,
          turnDurationMs: args.turnResult.durationMs,
          commit: IN_COMMIT,
        }).error;
  return error
    ? {
        failure: { reason: "runtime-reported-failure", error },
        followers: [],
        runtimeResults,
      }
    : { followers: deferred, runtimeResults };
}
