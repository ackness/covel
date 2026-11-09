import type { ExecutionCommitPlan, PreparedExecution } from "../execution.js";
import { unavailablePresentationJob } from "../presentation/jobs.js";
import { currentTraceRetention, type DeferredRuntimeJob } from "@covel/shared";
import type { DataStore } from "@covel/store";
import {
  deleteExpiredTraceEvents,
  maybeSweepOldTraces,
} from "./trace-retention.js";
import { deepFreeze } from "../hooks/hook-settings.js";
import { emitSubEvent } from "../turn-executor/turn-runtime-helpers.js";
import { saveAutoSnapshot } from "../snapshot/auto-snapshot.js";
import {
  applyIsolatedRuntimes,
  finalizeExecution,
  settleTurnResults,
  type FinalizeExecutionArgs,
  type FinalizeExecutionOutcome,
} from "./finalize-execution.js";

/** Executions handed to `commitExecution` or abandoned: settled by their owner. */
const settlementClaimed = new WeakSet<PreparedExecution>();

/** Jobs an uncommitted execution would have queued, whose presentation never comes. */
function presentationJobsOf(
  execution: PreparedExecution,
): DeferredRuntimeJob[] {
  const result = execution.result;
  if (!("runtimeResults" in result)) return [];
  return [
    ...(result.deferredRuntimeJobs ?? []),
    ...(result.withheldRuntimeJobs ?? []),
  ].filter((job) => job.presentation);
}

/** The caller owns the session lock and execution/continuation claim. */
export type ExecutionCompletion =
  | {
      readonly kind: "turn";
      readonly turnId: string;
      readonly durationMs: number;
    }
  | {
      readonly kind: "resume";
      readonly turnId: string;
      readonly suspensionId: string;
      readonly pluginId: string;
      readonly runtimeId: string;
    }
  | { readonly kind: "detached"; readonly turnId: string };

/** Queues held-back jobs in the commit transaction. */
type ReleasedJobsQueue = NonNullable<
  FinalizeExecutionArgs["enqueueReleasedJobsInTx"]
>;

/**
 * The released-job queue of a host that has none. A commit that would release
 * held-back jobs rolls back instead of losing them.
 */
export const refuseReleasedJobs: ReleasedJobsQueue = async () => {
  throw new Error(
    "cannot queue the jobs held back by a suspension this commit ends: the host has no released-job queue",
  );
};

export interface CommitExecutionArgs extends Omit<
  FinalizeExecutionArgs,
  keyof ExecutionCommitPlan | "loadOutputSchema" | "enqueueReleasedJobsInTx"
> {
  readonly execution: PreparedExecution;
  /**
   * Queues, in the commit transaction, the detached jobs held back by the
   * turn of a suspension this commit ends: an older suspension of the same
   * runtime that a new one replaces, or a continuation whose run was dropped
   * at commit. Every host decides: one that has no way to queue them passes
   * `refuseReleasedJobs`, and says why.
   */
  readonly enqueueReleasedJobsInTx: ReleasedJobsQueue;
  /** Restrict a detached commit to plugins still active under the session lock. */
  readonly activePluginIds?: ReadonlySet<string>;
  readonly completion: ExecutionCompletion;
  /** Transport delivery precedes the checkpoint and completion notification. */
  readonly onFinalized?: (
    outcome: FinalizeExecutionOutcome,
  ) => void | Promise<void>;
}

export interface CommitExecutionOutcome extends FinalizeExecutionOutcome {
  /** A checkpoint failure never changes an already durable commit to a failure. */
  readonly snapshotFailed: boolean;
}

/**
 * Host entry point for committing player, manual, background and resumed work.
 * Call once under the session lock; this is not an execution deduplication API.
 * Durable writes share finalizeExecution's transaction. Post-commit delivery,
 * checkpoints and memory are isolated so their failures cannot invite replay.
 */
export async function commitExecution(
  args: CommitExecutionArgs,
): Promise<CommitExecutionOutcome> {
  const plan = args.execution.commit;
  // From here on the commit settles the execution, whatever its outcome.
  settlementClaimed.add(args.execution);
  const outcome = await finalizeExecution({
    ...args,
    ...plan,
    // Activation can shrink during detached work, but a later activation must
    // never introduce hooks into an execution that did not capture them.
    activePluginIds: new Set(
      [
        ...(plan.activePluginIds ??
          plan.runtimes.map((runtime) => runtime.pluginId)),
      ].filter((pluginId) => args.activePluginIds?.has(pluginId) ?? true),
    ),
    hookSettings: deepFreeze(plan.hookSettings),
    loadOutputSchema: async (runtimeId) => plan.outputSchemas[runtimeId],
    extraInTx: async (tx, isolation) => {
      // The resumed runtime is the last result; nested results restored
      // with it come first. It either succeeded or suspended again.
      const resumed = plan.resolvedSuspensionId
        ? plan.results.at(-1)
        : undefined;
      if (
        plan.resolvedSuspensionId &&
        resumed?.status !== "success" &&
        resumed?.status !== "suspended"
      ) {
        throw new Error("Cannot commit an unsuccessful resumed execution");
      }
      await args.extraInTx?.(tx, isolation);
      // Resolved before the execution's suspensions are saved: a resume that
      // suspends again must not see its own claimed record as one to replace.
      if (plan.resolvedSuspensionId) {
        await tx.markSuspensionResolved(plan.resolvedSuspensionId);
      }
    },
  });
  try {
    await args.onFinalized?.(outcome);
  } catch (error) {
    console.warn("[commit-execution] outcome delivery failed:", error);
  }
  if (outcome.status !== "committed") {
    for (const job of presentationJobsOf(args.execution))
      await unavailablePresentationJob(args.store, plan.sessionId, job);
    return { ...outcome, snapshotFailed: false };
  }

  const { completion, store, eventBus } = args;
  const { sessionId } = plan;
  // A suspended run whose writes were dropped left no continuation behind.
  const suspended = applyIsolatedRuntimes(
    plan.results,
    outcome.isolatedRuntimes,
  ).some((result) => result.status === "suspended");
  if (completion.kind === "resume" && !suspended) {
    try {
      emitSubEvent(eventBus, "game", "turn.resumed", sessionId, {
        sessionId,
        turnId: completion.turnId,
        suspensionId: completion.suspensionId,
        pluginId: completion.pluginId,
        runtimeId: completion.runtimeId,
        runId: plan.results.at(-1)?.runId,
        resumeSourceRunId:
          plan.resumedSuspension?.pendingContinuation.lifecycle.progressRunId,
      });
    } catch (error) {
      console.warn("[commit-execution] resume notification failed:", error);
    }
  }

  let snapshotFailed = false;
  try {
    await saveAutoSnapshot({
      store,
      sessionId,
      turnId: completion.turnId,
      eventBus,
      force: completion.kind === "resume",
    });
  } catch (error) {
    snapshotFailed = true;
    console.warn(
      `[commit-execution] auto snapshot failed for ${sessionId}:`,
      error,
    );
  }

  // Optional trace retention; traces are diagnostics, so a failed cleanup
  // never affects the committed outcome.
  const traceRetentionDays = currentTraceRetention().days;
  if (traceRetentionDays > 0) {
    try {
      await deleteExpiredTraceEvents(
        store,
        sessionId,
        new Date(Date.now() - traceRetentionDays * 86_400_000).toISOString(),
      );
    } catch (error) {
      console.warn(
        `[commit-execution] trace retention failed for ${sessionId}:`,
        error,
      );
    }
    // Sessions nobody plays again are only reached by the daily sweep.
    void maybeSweepOldTraces(store);
  }

  if (!suspended && completion.kind !== "detached") {
    if (completion.kind === "turn") {
      try {
        emitSubEvent(eventBus, "game", "turn.completed", sessionId, {
          sessionId,
          turnId: completion.turnId,
          durationMs: completion.durationMs,
        });
      } catch (error) {
        console.warn(
          "[commit-execution] completion notification failed:",
          error,
        );
      }
    }
  }
  return { ...outcome, snapshotFailed };
}

export interface AbandonExecutionArgs {
  readonly execution: PreparedExecution;
  readonly store: Pick<DataStore, "setTurnResultCommitStatus"> &
    Parameters<typeof unavailablePresentationJob>[0];
}

/**
 * Host exit for a prepared execution it will not commit: a refusal after the
 * execution returned (session paused, approval or plugin version changed, a
 * commit barrier) or a throw before `commitExecution`. Its persisted turn
 * results settle `failed` instead of lingering `pending`, the crash signature,
 * and the jobs it would have queued report their presentation unavailable.
 *
 * Once the execution reached `commitExecution` this is a no-op: the commit owns
 * its settlement, committed or not. Best effort; never throws.
 */
export async function abandonExecution(
  args: AbandonExecutionArgs,
): Promise<void> {
  if (settlementClaimed.has(args.execution)) return;
  settlementClaimed.add(args.execution);
  const { sessionId, turnIds } = args.execution.commit;
  await settleTurnResults(args.store, sessionId, turnIds, "failed");
  for (const job of presentationJobsOf(args.execution)) {
    try {
      await unavailablePresentationJob(args.store, sessionId, job);
    } catch (error) {
      console.warn(
        `[commit-execution] presentation of abandoned job ${job.jobId} was not settled:`,
        error,
      );
    }
  }
}
