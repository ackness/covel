import type { ExecutionCommitPlan, PreparedExecution } from "../execution.js";
import { readEnvInt } from "@covel/shared";
import { deepFreeze } from "../hooks/hook-settings.js";
import { emitSubEvent } from "../turn-executor/turn-runtime-helpers.js";
import { saveAutoSnapshot } from "../snapshot/auto-snapshot.js";
import {
  finalizeExecution,
  type FinalizeExecutionArgs,
  type FinalizeExecutionOutcome,
} from "./finalize-execution.js";

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

export interface CommitExecutionArgs extends Omit<
  FinalizeExecutionArgs,
  keyof ExecutionCommitPlan | "loadOutputSchema"
> {
  readonly execution: PreparedExecution;
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
    extraInTx: async (tx) => {
      if (
        plan.resolvedSuspensionId &&
        plan.results.some((result) => result.status !== "success")
      ) {
        throw new Error("Cannot commit an unsuccessful resumed execution");
      }
      await args.extraInTx?.(tx);
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
    return { ...outcome, snapshotFailed: false };
  }

  const { completion, store, eventBus } = args;
  const { sessionId } = plan;
  const suspended = plan.results.some(
    (result) => result.status === "suspended",
  );
  if (completion.kind === "resume" && !suspended) {
    try {
      emitSubEvent(eventBus, "game", "turn.resumed", sessionId, {
        sessionId,
        turnId: completion.turnId,
        suspensionId: completion.suspensionId,
        pluginId: completion.pluginId,
        runtimeId: completion.runtimeId,
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
  const traceRetentionDays = readEnvInt("COVEL_TRACE_RETENTION_DAYS", 0);
  if (traceRetentionDays > 0) {
    try {
      await store.deleteTraceEventsBefore(
        sessionId,
        new Date(Date.now() - traceRetentionDays * 86_400_000).toISOString(),
      );
    } catch (error) {
      console.warn(
        `[commit-execution] trace retention failed for ${sessionId}:`,
        error,
      );
    }
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
