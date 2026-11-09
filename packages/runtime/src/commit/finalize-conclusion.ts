/**
 * What follows a finalize once its domain outcome is known, outside the
 * transaction: the `turn_results` rows and operations of a rolled-back
 * execution settle `failed`, presentations complete, reported jobs reach a
 * terminal state, the lifecycles saved with suspensions are corrected and
 * setup runtimes settle their attempts.
 */

import type { DataStore } from "@covel/store";
import type { OperationSettlement } from "@covel/shared";
import {
  presentationState,
  completePresentation,
} from "../presentation/state.js";
import {
  finalizeJobStatuses,
  type ExecutionJobOutcome,
} from "../job-status/job-status.js";
import { jobOwnership } from "../job-status/job-ownership.js";
import {
  correctSavedLifecycle,
  correctRuntimeLifecycle,
  savedMembers,
} from "../resume/suspended-lifecycle.js";
import { settleSetupRuntimes } from "./setup-settle.js";
import { flushPostCommit } from "./post-commit-fanout.js";
import { applyIsolatedRuntimes } from "./commit-isolation.js";
import { settlementsOf, type OperationLedger } from "./operation-ledger.js";
import type {
  FinalizeExecutionArgs,
  FinalizeExecutionOutcome,
} from "./finalize-types.js";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Best effort: a store failure is logged, never thrown. */
export async function settleTurnResults(
  store: Pick<DataStore, "setTurnResultCommitStatus">,
  sessionId: string,
  turnIds: readonly string[],
  status: "committed" | "failed",
  settledOperations: readonly OperationSettlement[] = [],
): Promise<void> {
  for (const turnId of turnIds) {
    try {
      await store.setTurnResultCommitStatus(
        sessionId,
        turnId,
        status,
        [],
        settledOperations,
      );
    } catch (err) {
      console.warn(
        `[finalize-execution] failed to settle commitStatus (${status}) for turn ${turnId}:`,
        errorMessage(err),
      );
    }
  }
}

/** Map one runtime result's status onto the job-terminal outcome vocabulary. */
function jobOutcomeForResult(status: string | undefined): ExecutionJobOutcome {
  switch (status) {
    case "failed":
      return "failed";
    case "skipped":
      return "skipped";
    case "suspended":
      return "suspended";
    default:
      return "success";
  }
}

/**
 * Terminalise every job reported under this execution's progress scope. Runs
 * after the domain outcome is settled: a rolled-back execution fails all its
 * jobs; a committed one maps each job to its owning runtime's result status.
 * A suspended runtime's jobs wait for input, a claimed success too, since its
 * writes are held until the suspension is resumed; so do the jobs of the
 * `ctx.recursiveCall` children saved with it, which share this scope. A
 * reporting runtime with no result at all (a child whose parent failed) is
 * cancelled.
 * In a continued scope (a resume) only the jobs of the runtimes this
 * execution owns are settled. A rollback fails them, including claimed
 * successes, and a later retry can correct framework-owned failures.
 * Job-status is append-only and non-transactional by design, so a failure here
 * is logged and never re-opens the domain outcome.
 */
async function terminalizeExecutionJobs(
  args: FinalizeExecutionArgs,
  outcome: FinalizeExecutionOutcome,
): Promise<void> {
  const status = outcome.status;
  const continued = args.progressScopeId;
  const scopeId = continued ?? args.executionContext?.executionId;
  if (!scopeId) return;
  try {
    const reported = await args.store.listJobStatus(args.sessionId, {
      progressScopeId: scopeId,
    });
    if (reported.length === 0) return;
    const settled = applyIsolatedRuntimes(
      args.results,
      outcome.isolatedRuntimes,
    );
    const outcomes = new Map<string, ExecutionJobOutcome>();
    const key = (pluginId: string, runtimeId: string, runId: string) =>
      JSON.stringify([pluginId, runtimeId, runId]);
    for (const result of settled)
      outcomes.set(
        key(result.pluginId, result.runtimeId, result.runId),
        jobOutcomeForResult(result.status),
      );
    const root = settled.at(-1);
    if (args.resumedSuspension && root) {
      for (const member of savedMembers(args.resumedSuspension))
        outcomes.set(
          key(member.pluginId, member.runtimeId, member.progressRunId),
          jobOutcomeForResult(root.status),
        );
    }
    for (const suspension of args.suspensions ?? []) {
      const holder = settled.find(
        (result) =>
          result.runId === suspension.pendingContinuation.lifecycle.runId,
      );
      if (!holder) continue;
      for (const member of savedMembers(suspension))
        outcomes.set(
          key(member.pluginId, member.runtimeId, member.progressRunId),
          jobOutcomeForResult(holder.status),
        );
    }
    const latest = new Map<string, (typeof reported)[number]>();
    for (const row of reported)
      latest.set(JSON.stringify([row.pluginId, row.runtimeId, row.jobId]), row);
    for (const row of latest.values()) {
      const owner = jobOwnership(row);
      // Direct kernel reporters without invocation correlation retain their
      // explicit runtime identity. Plugin contexts always provide ownership.
      const memberOutcome = owner
        ? outcomes.get(key(row.pluginId, row.runtimeId, owner.runId))
        : settled.find(
            (result) =>
              result.pluginId === row.pluginId &&
              result.runtimeId === row.runtimeId,
          )?.status;
      if (
        continued &&
        memberOutcome === undefined &&
        owner?.attemptId !== args.progressAttemptId
      )
        continue;
      const rolledBack = status === "failed";
      const discarded = memberOutcome === undefined;
      await finalizeJobStatuses(
        {
          store: args.store,
          eventBus: args.eventBus,
          sessionId: args.sessionId,
          progressScopeId: scopeId,
          pluginId: row.pluginId,
          runtimeId: row.runtimeId,
        },
        {
          outcome: rolledBack
            ? "failed"
            : discarded
              ? "skipped"
              : jobOutcomeForResult(memberOutcome),
          reportedJobs: [row.jobId],
          rolledBack: rolledBack || discarded,
        },
      );
    }
  } catch (err) {
    console.warn(
      "[finalize-execution] job-status terminalisation failed:",
      errorMessage(err),
    );
  }
}

/**
 * Every exit of `finalizeExecution` funnels through here so reported jobs
 * always reach a terminal state, whatever the domain outcome.
 */
export async function concludeExecution(
  args: FinalizeExecutionArgs,
  ledger: OperationLedger,
  outcome: FinalizeExecutionOutcome,
): Promise<FinalizeExecutionOutcome> {
  const { store, sessionId, turnIds, results, emitter, sessionClock } = args;
  if (outcome.status === "failed") {
    // Nothing of the execution landed, its operations included.
    const operations = ledger.finalized({
      status: "discarded",
      reason: "execution-failed",
    });
    await settleTurnResults(
      store,
      sessionId,
      turnIds,
      "failed",
      settlementsOf(operations),
    );
    outcome = { ...outcome, operations };
  }
  for (const result of results) {
    const state = presentationState(result);
    if (!state) continue;
    const isolated = outcome.isolatedRuntimes?.some(
      (entry) => entry.runId === result.runId,
    );
    const failed = result.status === "failed" || isolated;
    const updated =
      outcome.status === "committed" &&
      !failed &&
      (state.committedWrites ?? 0) > 0;
    await completePresentation(
      emitter,
      result,
      state,
      updated ? "updated" : failed ? "failed" : "no-op",
      failed
        ? "failed"
        : outcome.status === "failed"
          ? "unavailable"
          : state.reason,
    );
  }
  await terminalizeExecutionJobs(args, outcome);
  const lifecycleCorrections: (() => Promise<void>)[] = [];
  if (args.resumedSuspension) {
    const resumed = applyIsolatedRuntimes(
      args.results,
      outcome.isolatedRuntimes,
    ).at(-1);
    const effectiveStatus =
      outcome.status === "failed"
        ? "failed"
        : jobOutcomeForResult(resumed?.status);
    const suspension = args.resumedSuspension;
    lifecycleCorrections.push(() =>
      correctSavedLifecycle(args, suspension, effectiveStatus),
    );
    const invocation = args.results.at(-1);
    if (invocation && invocation.status !== effectiveStatus)
      lifecycleCorrections.push(() =>
        correctRuntimeLifecycle(
          args,
          args.sessionId,
          invocation,
          effectiveStatus,
        ),
      );
  }
  for (const suspension of args.suspensions ?? []) {
    const holder = applyIsolatedRuntimes(
      args.results,
      outcome.isolatedRuntimes,
    ).find(
      (result) =>
        result.runId === suspension.pendingContinuation.lifecycle.runId,
    );
    lifecycleCorrections.push(() =>
      correctSavedLifecycle(
        args,
        suspension,
        outcome.status === "failed"
          ? "failed"
          : jobOutcomeForResult(holder?.status),
        outcome.status === "failed" || holder?.status !== "suspended",
      ),
    );
  }
  if (
    await flushPostCommit(lifecycleCorrections, {
      sessionId,
      label: "saved-lifecycle",
      eventBus: args.eventBus,
      emitter,
    })
  )
    outcome = { ...outcome, fanOutFailed: true };
  if (args.setupRan && args.setupRan.length > 0) {
    try {
      await settleSetupRuntimes({
        store,
        sessionId,
        ran: args.setupRan,
        committed: outcome.status === "committed",
        now: sessionClock?.now ?? new Date().toISOString(),
      });
    } catch (err) {
      console.warn(
        "[finalize-execution] setup-runtime settle failed:",
        errorMessage(err),
      );
    }
  }
  return outcome;
}
