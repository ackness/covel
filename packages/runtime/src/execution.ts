import type {
  DeferredRuntimeJob,
  RuntimeManifest,
  RuntimeResult,
  TurnInput,
  TurnResult,
} from "@covel/shared";
import type { DataStore, SuspensionRecord } from "@covel/store";
import {
  collectExecutionJournal,
  attachRuntimeJournal,
} from "./execution-journal.js";
import { collectExecutionSuspensions } from "./suspension-artifact.js";
import { runWithHookScope } from "./hooks/hook-scope.js";
import {
  buildHookSettings,
  snapshotUserSettings,
} from "./hooks/hook-settings.js";
import { executeTurn as runTurn } from "./turn-executor/turn-executor.js";
import {
  resumeSuspendedRuntime as resumeRuntime,
  type ResumeSuspendedRuntimeOptions,
} from "./resume/turn-resume.js";
import type {
  TurnExecutorDeps,
  TurnExecutorOptions,
} from "./turn-executor/turn-executor-types.js";
import type { FinalizeExecutionArgs } from "./commit/finalize-execution.js";
import { getTurnExecutionSignal } from "./turn-executor/turn-control.js";

type Schema = Readonly<Record<string, unknown>>;

/** Everything produced by execution that must cross the atomic commit boundary. */
export interface ExecutionCommitPlan extends Pick<
  FinalizeExecutionArgs,
  | "sessionId"
  | "executionContext"
  | "runtimes"
  | "results"
  | "journalMessages"
  | "suspensions"
  | "turnIds"
  | "activePluginIds"
  | "hookSettings"
  | "sessionClock"
  | "setupRan"
  | "abortReason"
> {
  readonly outputSchemas: Readonly<Record<string, Schema>>;
  readonly resolvedSuspensionId?: string;
  /**
   * Detached jobs the suspended turn held back, released by the resume that
   * completes it. The host queues them inside the same commit.
   */
  readonly releasedRuntimeJobs?: readonly DeferredRuntimeJob[];
}

/** Only `result` is a transport payload. The commit plan stays with the host. */
export interface PreparedExecution<T = TurnResult | RuntimeResult> {
  readonly result: T;
  readonly commit: ExecutionCommitPlan;
}

export type ExecutedTurn = PreparedExecution<TurnResult>;
export type ExecutedRuntime = PreparedExecution<RuntimeResult>;
export type ExecutionDeps = TurnExecutorDeps & { readonly store: DataStore };

function captureSchemas(deps: ExecutionDeps) {
  const outputSchemas: Record<string, Schema> = {};
  return {
    outputSchemas,
    deps: {
      ...deps,
      loadRuntime: async (
        ...args: Parameters<TurnExecutorDeps["loadRuntime"]>
      ) => {
        const loaded = await deps.loadRuntime(...args);
        if (loaded?.outputSchema) {
          outputSchemas[args[0].name] = structuredClone(loaded.outputSchema);
        }
        return loaded;
      },
    } satisfies ExecutionDeps,
  };
}

function publicRuntimeResult(result: RuntimeResult): RuntimeResult {
  const { pendingProposals: _pendingProposals, ...visible } = result;
  return structuredClone(visible);
}

/** Execute a turn and retain its complete commit plan, including nested work. */
export async function executeTurn(
  input: TurnInput,
  runtimes: readonly RuntimeManifest[],
  deps: ExecutionDeps,
  options?: TurnExecutorOptions,
): Promise<ExecutedTurn> {
  const captured = captureSchemas(deps);
  const userSettings = snapshotUserSettings(input.userSettings);
  const hookScope = {
    activePluginIds: new Set(
      deps.hookScope?.activePluginIds ??
        runtimes.map((runtime) => runtime.pluginId),
    ),
    settings: deps.hookScope
      ? snapshotUserSettings(deps.hookScope.settings)
      : buildHookSettings(runtimes, userSettings),
  };
  const turn = await runTurn(
    { ...input, userSettings },
    runtimes,
    { ...captured.deps, hookScope },
    options,
  );
  const results = [
    ...turn.runtimeResults,
    ...(turn.nestedRuntimeResults ?? []),
  ];
  const executionSignal = getTurnExecutionSignal(deps.turnControl);
  const abortReason =
    turn.abortReason ??
    (executionSignal?.aborted
      ? executionSignal.reason instanceof Error
        ? executionSignal.reason.message
        : "Execution was cancelled"
      : undefined);
  const suspended = results.some((result) => result.status === "suspended");
  // Every sibling suspension carries the held-back jobs; whichever resume
  // completes the turn queues them.
  const withheldRuntimeJobs = turn.withheldRuntimeJobs?.length
    ? turn.withheldRuntimeJobs.map((job) => ({
        ...job,
        upstreamResults: job.upstreamResults.map(publicRuntimeResult),
      }))
    : undefined;
  return {
    result: {
      ...structuredClone(turn),
      runtimeResults: turn.runtimeResults.map(publicRuntimeResult),
      ...(turn.auditResult
        ? { auditResult: publicRuntimeResult(turn.auditResult) }
        : {}),
      ...(turn.deferredRuntimeJobs
        ? {
            deferredRuntimeJobs: turn.deferredRuntimeJobs.map((job) => ({
              ...structuredClone(job),
              upstreamResults: job.upstreamResults.map(publicRuntimeResult),
            })),
          }
        : {}),
      ...(turn.nestedRuntimeResults
        ? {
            nestedRuntimeResults:
              turn.nestedRuntimeResults.map(publicRuntimeResult),
          }
        : {}),
    },
    commit: {
      ...structuredClone({
        sessionId: turn.sessionId,
        executionContext: suspended
          ? { ...turn.executionContext, countPolicy: "none" as const }
          : turn.executionContext,
        runtimes,
        results,
        ...(abortReason !== undefined ? { abortReason } : {}),
        journalMessages: collectExecutionJournal(turn),
        suspensions: collectExecutionSuspensions(turn).map((record) => {
          const counted =
            turn.executionContext.countPolicy === "complete-player-turn" &&
            turn.executionContext.logicalTurnId ===
              record.pendingContinuation.executionContext.logicalTurnId;
          if (!counted && !withheldRuntimeJobs) return record;
          return {
            ...record,
            pendingContinuation: {
              ...record.pendingContinuation,
              ...(counted
                ? {
                    executionContext: {
                      ...record.pendingContinuation.executionContext,
                      countPolicy: "complete-player-turn" as const,
                    },
                  }
                : {}),
              ...(withheldRuntimeJobs ? { withheldRuntimeJobs } : {}),
            },
          };
        }),
        turnIds: [turn.turnId],
        activePluginIds: hookScope.activePluginIds,
        ...(input.origin === "player"
          ? {
              sessionClock: {
                now: new Date().toISOString(),
                ...(turn.setupCompletion
                  ? { setupCompletion: turn.setupCompletion }
                  : {}),
              },
            }
          : {}),
        ...(turn.setupRan ? { setupRan: turn.setupRan } : {}),
        outputSchemas: captured.outputSchemas,
      }),
      hookSettings: hookScope.settings,
    },
  };
}

/** Resume under the host's session lock; the returned plan resolves the claim on commit. */
export async function resumeSuspendedRuntime(
  suspension: SuspensionRecord,
  resumeData: unknown,
  manifest: RuntimeManifest,
  deps: ExecutionDeps,
  options?: ResumeSuspendedRuntimeOptions,
): Promise<ExecutedRuntime> {
  const captured = captureSchemas(deps);
  const userSettings = snapshotUserSettings(options?.userSettings);
  const hookScope = {
    activePluginIds: new Set(
      deps.hookScope?.activePluginIds ?? [manifest.pluginId],
    ),
    settings: deps.hookScope
      ? snapshotUserSettings(deps.hookScope.settings)
      : buildHookSettings([manifest], userSettings),
  };
  const result = await runWithHookScope(hookScope, () =>
    resumeRuntime(
      suspension,
      resumeData,
      manifest,
      { ...captured.deps, hookScope },
      { ...options, userSettings },
    ),
  );
  const inherited = suspension.pendingContinuation.executionContext;
  const hasUnresolvedSibling = inherited.logicalTurnId
    ? (await deps.store.listSuspensions(suspension.sessionId)).some(
        (candidate) =>
          candidate.id !== suspension.id &&
          candidate.resolvedAt === undefined &&
          candidate.pendingContinuation.executionContext.logicalTurnId ===
            inherited.logicalTurnId,
      )
    : false;
  const releasedRuntimeJobs =
    !hasUnresolvedSibling && result.status === "success"
      ? (suspension.pendingContinuation.withheldRuntimeJobs as
          readonly DeferredRuntimeJob[] | undefined)
      : undefined;
  const carrier = { runtimeResults: [result] };
  if (
    result.status === "success" &&
    result.output &&
    collectExecutionJournal(carrier).length === 0
  ) {
    attachRuntimeJournal(
      result,
      {
        sessionId: suspension.sessionId,
        turnId: suspension.turnId,
        playerMessage: "",
        origin: "resume",
      },
      manifest,
      result.output,
    );
  }
  return {
    result: publicRuntimeResult(result),
    commit: {
      ...structuredClone({
        sessionId: suspension.sessionId,
        executionContext: {
          ...inherited,
          executionId: result.runId,
          origin: "resume" as const,
          ...(hasUnresolvedSibling || result.status === "suspended"
            ? { countPolicy: "none" as const }
            : {}),
        },
        runtimes: [manifest],
        results: [result],
        journalMessages: collectExecutionJournal(carrier),
        suspensions: collectExecutionSuspensions(carrier),
        turnIds: [],
        activePluginIds: hookScope.activePluginIds,
        sessionClock: { now: new Date().toISOString() },
        outputSchemas: captured.outputSchemas,
        resolvedSuspensionId: suspension.id,
        ...(releasedRuntimeJobs?.length ? { releasedRuntimeJobs } : {}),
      }),
      hookSettings: hookScope.settings,
    },
  };
}
