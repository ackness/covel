import type {
  DeferredRuntimeJob,
  RuntimeManifest,
  RuntimeResult,
  TurnInput,
  TurnResult,
} from "@covel/shared";
import { isSetupRuntime } from "@covel/shared";
import {
  createSubagentRunner,
  type SubagentSettledEvent,
} from "./agent-loop/subagent-runner.js";
import type { SubagentRunOutcome } from "./faults/classify.js";
import type { DataStore, SuspensionRecord } from "@covel/store";
import {
  collectExecutionJournal,
  collectExecutionJournalRuns,
  collectExecutionTriggerRuns,
  collectExecutionTriggers,
  attachRuntimeJournal,
  runtimeTriggerOf,
} from "./execution-journal.js";
import {
  collectExecutionSuspensionRuns,
  collectExecutionSuspensions,
} from "./suspension-artifact.js";
import { collectExecutionReadDependencies } from "./read-dependencies.js";
import { runWithHookScope } from "./hooks/hook-scope.js";
import {
  buildHookSettings,
  snapshotUserSettings,
} from "./hooks/hook-settings.js";
import { runTurnPipeline } from "./turn-executor/turn-executor.js";
import {
  commitUnitSizes,
  inCommitOrder,
  nestedResultsOf,
} from "./turn-executor/nested-results.js";
import {
  resumeRuntimePipeline,
  type ResumeSuspendedRuntimeOptions,
} from "./resume/turn-resume.js";
import type {
  TurnExecutorDeps,
  TurnExecutorOptions,
} from "./turn-executor/turn-executor-types.js";
import type { FinalizeExecutionArgs } from "./commit/finalize-execution.js";
import { getTurnExecutionSignal } from "./turn-executor/turn-control.js";
import { SetupCompletionTracker } from "./turn-executor/setup-completion-tracker.js";
import { collectSetupRan } from "./turn-executor/setup-run.js";
import {
  countPlayerTurns,
  hasPendingSibling,
} from "./resume/suspension-settlement.js";
import { suspensionProgressScopeId } from "./resume/suspension-progress-scope.js";
import { createOperationExecutionScope } from "./operations/operation-stage.js";

type Schema = Readonly<Record<string, unknown>>;

/** Everything produced by execution that must cross the atomic commit boundary. */
export interface ExecutionCommitPlan extends Pick<
  FinalizeExecutionArgs,
  | "sessionId"
  | "executionContext"
  | "runtimes"
  | "results"
  | "commitUnits"
  | "journalMessages"
  | "journalMessageRuns"
  | "runtimeTriggers"
  | "runtimeTriggerRuns"
  | "suspensions"
  | "suspensionRuns"
  | "writeBaseline"
  | "turnIds"
  | "activePluginIds"
  | "hookSettings"
  | "hookLocale"
  | "sessionClock"
  | "setupRan"
  | "abortReason"
  | "datasetSchemas"
  | "providerDatasets"
  | "readDependencies"
  | "progressScopeId"
> {
  readonly outputSchemas: Readonly<Record<string, Schema>>;
  readonly subagentRuns?: readonly SubagentRunOutcome[];
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
  const datasetSchemas: Record<string, Readonly<Record<string, Schema>>> = {};
  return {
    outputSchemas,
    datasetSchemas,
    deps: {
      ...deps,
      loadRuntime: async (
        ...args: Parameters<TurnExecutorDeps["loadRuntime"]>
      ) => {
        const loaded = await deps.loadRuntime(...args);
        if (loaded?.outputSchema) {
          // Loader schemas are shared per registry generation. Preserve identity
          // so export validation reuses the compiled validator across executions.
          outputSchemas[args[0].name] = loaded.outputSchema;
        }
        if (loaded?.datasetSchemas) {
          // Same identity rule: commit validates dataset writes with these.
          datasetSchemas[loaded.manifest.pluginId] = loaded.datasetSchemas;
        }
        return loaded;
      },
    } satisfies ExecutionDeps,
  };
}

function publicRuntimeResult(result: RuntimeResult): RuntimeResult {
  const {
    pendingProposals: _pendingProposals,
    operationWrites: _operationWrites,
    ...visible
  } = result;
  return structuredClone(visible);
}

/**
 * Setup bookkeeping for a resumed setup runtime, in the shape a turn hands the
 * finalizer: the completion delta (done mirror and phase flip, written with the
 * domain commit) and the attempt to settle. The resume finishes the attempt
 * the suspended execution started, so it settles under that execution's id.
 */
async function resumedSetupState(args: {
  readonly store: DataStore;
  readonly suspension: SuspensionRecord;
  readonly manifest: RuntimeManifest;
  readonly activeRuntimes: readonly RuntimeManifest[];
  readonly result: RuntimeResult;
}): Promise<Pick<TurnResult, "setupCompletion" | "setupRan">> {
  const { store, suspension, manifest, result } = args;
  if (!isSetupRuntime(manifest)) return {};
  const session = await store.getSession(suspension.sessionId);
  if (!session) return {};
  const activeSetupRuntimes = args.activeRuntimes.filter(isSetupRuntime);
  const tracker = new SetupCompletionTracker({
    activeSetupRuntimes,
    setupRuntimes: session.setupRuntimes,
    preGameRuntimes: activeSetupRuntimes,
    isPreGamePending: session.phase === "setup",
    isManualTrigger: false,
  });
  const completedResults = new Map([[manifest.name, result]]);
  tracker.recordPreGameCompletion(completedResults);
  const setupRan = collectSetupRan({
    activeRuntimes: [manifest],
    completedResults,
    setupRuntimes: tracker.mirror,
    executionId: suspension.pendingContinuation.executionContext.executionId,
  });
  tracker.foldSetupRan(setupRan);
  const setupCompletion = tracker.setupCompletion;
  return {
    ...(setupCompletion ? { setupCompletion } : {}),
    ...(setupRan.length > 0 ? { setupRan } : {}),
  };
}

/** Execute a turn and retain its complete commit plan, including nested work. */
export async function executeTurn(
  input: TurnInput,
  runtimes: readonly RuntimeManifest[],
  deps: ExecutionDeps,
  options?: TurnExecutorOptions,
): Promise<ExecutedTurn> {
  // Freeze admission once. A hook may latch a plugin during this execution.
  const paused = new Set(
    [
      ...(deps.hookScope?.activePluginIds ?? []),
      ...runtimes.map((runtime) => runtime.pluginId),
    ].filter((pluginId) =>
      deps.pluginFaults?.isLatched(input.sessionId, pluginId),
    ),
  );
  const pausedRuntimes = runtimes.filter((runtime) =>
    paused.has(runtime.pluginId),
  );
  runtimes = runtimes.filter((runtime) => !paused.has(runtime.pluginId));
  const subagentRuns: SubagentSettledEvent[] = [];
  const subagents =
    deps.subagents ??
    createSubagentRunner({
      activeRuntimes: runtimes,
      pausedRuntimes,
      onSettled: (event) => subagentRuns.push(event),
    });
  const captured = captureSchemas(deps);
  // Shared by every run of this execution and its nested executions.
  const operationScope =
    deps.operationScope ??
    createOperationExecutionScope(deps.loadPluginDatasets);
  const userSettings = snapshotUserSettings(input.userSettings);
  const hookScope = {
    logicalKey: input.logicalTurnId ?? input.turnId,
    activePluginIds: new Set(
      [
        ...(deps.hookScope?.activePluginIds ??
          runtimes.map((runtime) => runtime.pluginId)),
      ].filter((pluginId) => !paused.has(pluginId)),
    ),
    settings: deps.hookScope
      ? snapshotUserSettings(deps.hookScope.settings)
      : buildHookSettings(runtimes, userSettings),
    locale: deps.hookScope?.locale ?? input.locale,
  };
  const turn = await runTurnPipeline(
    { ...input, userSettings },
    runtimes,
    { ...captured.deps, hookScope, subagents, operationScope },
    options,
  );
  // Each top-level result commits as one unit with everything nested under
  // it, children before their parent; finalize settles units in order, so
  // upstreams settle before the runtimes that depend on them.
  const results = inCommitOrder(turn.runtimeResults);
  const commitUnits = commitUnitSizes(turn.runtimeResults);
  const executionSignal = getTurnExecutionSignal(deps.turnControl);
  const abortReason =
    turn.abortReason ??
    (executionSignal?.aborted
      ? executionSignal.reason instanceof Error
        ? executionSignal.reason.message
        : "Execution was cancelled"
      : undefined);
  const suspended = results.some((result) => result.status === "suspended");
  const journalMessages = collectExecutionJournal(turn);
  const executionSuspensions = collectExecutionSuspensions(turn);
  // A suspension records what it was taken under: the player turns in the
  // history once this execution commits, and its plugin's version. A resume
  // that finds either changed is voided.
  const playerTurns =
    executionSuspensions.length > 0
      ? (await countPlayerTurns(deps.store, turn.sessionId)) +
        journalMessages.filter((message) => message.sourceType === "player")
          .length
      : 0;
  // Every sibling suspension carries the held-back jobs; whichever resume
  // completes the turn queues them.
  const withheldRuntimeJobs = turn.withheldRuntimeJobs?.length
    ? turn.withheldRuntimeJobs.map((job) => ({
        ...job,
        upstreamResults: job.upstreamResults.map(publicRuntimeResult),
      }))
    : undefined;
  const {
    runtimeResults,
    auditResult,
    deferredRuntimeJobs,
    nestedRuntimeResults,
    ...rest
  } = turn;
  return {
    result: {
      ...structuredClone(rest),
      runtimeResults: runtimeResults.map(publicRuntimeResult),
      ...(auditResult ? { auditResult: publicRuntimeResult(auditResult) } : {}),
      ...(deferredRuntimeJobs
        ? {
            deferredRuntimeJobs: deferredRuntimeJobs.map(
              ({ upstreamResults, ...job }) => ({
                ...structuredClone(job),
                upstreamResults: upstreamResults.map(publicRuntimeResult),
              }),
            ),
          }
        : {}),
      ...(nestedRuntimeResults
        ? {
            nestedRuntimeResults: nestedRuntimeResults.map(publicRuntimeResult),
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
        // Abandoned, cancelled runs that settle after this snapshot are
        // neutral and do not enter the commit plan.
        ...(subagentRuns.length ? { subagentRuns } : {}),
        commitUnits,
        ...(abortReason !== undefined ? { abortReason } : {}),
        journalMessages,
        journalMessageRuns: collectExecutionJournalRuns(turn),
        // A resume has no upstream in its execution, so it carries none.
        readDependencies: collectExecutionReadDependencies(turn),
        suspensionRuns: collectExecutionSuspensionRuns(turn),
        runtimeTriggers: collectExecutionTriggers(turn),
        runtimeTriggerRuns: collectExecutionTriggerRuns(turn),
        suspensions: executionSuspensions.map((record) => {
          const counted =
            turn.executionContext.countPolicy === "complete-player-turn" &&
            turn.executionContext.logicalTurnId ===
              record.pendingContinuation.executionContext.logicalTurnId;
          return {
            ...record,
            pendingContinuation: {
              ...record.pendingContinuation,
              takenUnder: {
                ...record.pendingContinuation.takenUnder,
                playerTurns,
              },
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
      }),
      outputSchemas: captured.outputSchemas,
      datasetSchemas: captured.datasetSchemas,
      // Datasets of the providers of write services this execution called,
      // so their writes are checked even when no runtime of theirs ran.
      providerDatasets: operationScope.providerDatasets(),
      hookSettings: hookScope.settings,
      hookLocale: hookScope.locale,
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
  if (deps.pluginFaults?.isLatched(suspension.sessionId, manifest.pluginId))
    throw new Error("Plugin is unavailable in this session");
  const activeRuntimes = options?.activeRuntimes ?? [manifest];
  const paused = new Set(
    [
      ...(deps.hookScope?.activePluginIds ?? []),
      ...activeRuntimes.map((runtime) => runtime.pluginId),
    ].filter((pluginId) =>
      deps.pluginFaults?.isLatched(suspension.sessionId, pluginId),
    ),
  );
  const subagentRuns: SubagentSettledEvent[] = [];
  const subagents =
    deps.subagents ??
    createSubagentRunner({
      activeRuntimes: activeRuntimes.filter(
        (runtime) => !paused.has(runtime.pluginId),
      ),
      pausedRuntimes: activeRuntimes.filter((runtime) =>
        paused.has(runtime.pluginId),
      ),
      onSettled: (event) => subagentRuns.push(event),
    });
  const captured = captureSchemas(deps);
  const userSettings = snapshotUserSettings(options?.userSettings);
  const hookScope = {
    logicalKey:
      suspension.pendingContinuation.executionContext.logicalTurnId ??
      suspension.turnId,
    activePluginIds: new Set(
      [...(deps.hookScope?.activePluginIds ?? [manifest.pluginId])].filter(
        (pluginId) => !paused.has(pluginId),
      ),
    ),
    settings: deps.hookScope
      ? snapshotUserSettings(deps.hookScope.settings)
      : buildHookSettings([manifest], userSettings),
    locale: deps.hookScope?.locale ?? suspension.pendingContinuation.locale,
  };
  const result = await runWithHookScope(hookScope, () =>
    resumeRuntimePipeline(
      suspension,
      resumeData,
      manifest,
      { ...captured.deps, hookScope, subagents },
      { ...options, userSettings },
    ),
  );
  const inherited = suspension.pendingContinuation.executionContext;
  // The scope its tasks report under, which a nested child's suspension
  // keeps apart from its execution identity.
  const progressScopeId = suspensionProgressScopeId(
    suspension.pendingContinuation,
  );
  const hasUnresolvedSibling = hasPendingSibling(
    suspension,
    await deps.store.listSuspensions(suspension.sessionId),
  );
  const releasedRuntimeJobs =
    !hasUnresolvedSibling && result.status === "success"
      ? (suspension.pendingContinuation.withheldRuntimeJobs as
          readonly DeferredRuntimeJob[] | undefined)
      : undefined;
  // Nested results restored from the suspension commit with the resumed
  // parent, children first, as one unit.
  const carrier = {
    runtimeResults: [result],
    nestedRuntimeResults: nestedResultsOf([result]),
  };
  if (
    result.status === "success" &&
    result.output &&
    runtimeTriggerOf(result) === undefined
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
  // A resumed run that suspends again continues the same logical runtime:
  // its new record keeps the chain's identity, so the resume that finally
  // ends it counts the turn once, releases the held-back jobs once and
  // settles the suspended execution's progress jobs.
  const suspensions = collectExecutionSuspensions(carrier).map((record) => {
    const {
      withheldRuntimeJobs: _own,
      progressScopeId: _ownScope,
      ...continuation
    } = record.pendingContinuation;
    const withheld = suspension.pendingContinuation.withheldRuntimeJobs;
    return {
      ...record,
      pendingContinuation: {
        ...continuation,
        executionContext: inherited,
        ...(progressScopeId !== inherited.executionId
          ? { progressScopeId }
          : {}),
        takenUnder: {
          ...continuation.takenUnder,
          playerTurns: suspension.pendingContinuation.takenUnder.playerTurns,
        },
        ...(withheld ? { withheldRuntimeJobs: withheld } : {}),
      },
    };
  });
  // The commit reads each result's manifest (its output kind, its setup
  // role), nested results' included.
  const results = inCommitOrder([result]);
  const runtimes = [
    manifest,
    ...(options?.activeRuntimes ?? []).filter(
      (runtime) =>
        runtime.name !== manifest.name &&
        results.some((nested) => nested.runtimeId === runtime.name),
    ),
  ];
  // Restored nested results ran in an earlier leg, so this run never loaded
  // their runtimes. Load each one that declares an export, without running
  // its handler, so the commit can validate and publish the child's output.
  for (const runtime of runtimes) {
    if (
      runtime === manifest ||
      !runtime.output?.recordAs ||
      captured.outputSchemas[runtime.name]
    )
      continue;
    await captured.deps.loadRuntime(
      runtime,
      suspension.pendingContinuation.locale,
      suspension.sessionId,
    );
  }
  const setup = await resumedSetupState({
    store: deps.store,
    suspension,
    manifest,
    activeRuntimes: options?.activeRuntimes ?? [manifest],
    result,
  });
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
        runtimes,
        results,
        commitUnits: commitUnitSizes([result]),
        ...(subagentRuns.length ? { subagentRuns } : {}),
        journalMessages: collectExecutionJournal(carrier),
        journalMessageRuns: collectExecutionJournalRuns(carrier),
        runtimeTriggers: collectExecutionTriggers(carrier),
        runtimeTriggerRuns: collectExecutionTriggerRuns(carrier),
        suspensions,
        suspensionRuns: collectExecutionSuspensionRuns(carrier),
        turnIds: [],
        activePluginIds: hookScope.activePluginIds,
        sessionClock: {
          now: new Date().toISOString(),
          ...(setup.setupCompletion
            ? { setupCompletion: setup.setupCompletion }
            : {}),
        },
        ...(setup.setupRan ? { setupRan: setup.setupRan } : {}),
        resolvedSuspensionId: suspension.id,
        writeBaseline: suspension.pendingContinuation.takenUnder.writes,
        // Every leg reports progress under the suspended execution; this
        // leg's own identity stays in `executionContext`.
        progressScopeId,
        ...(releasedRuntimeJobs?.length ? { releasedRuntimeJobs } : {}),
      }),
      outputSchemas: captured.outputSchemas,
      datasetSchemas: captured.datasetSchemas,
      hookSettings: hookScope.settings,
      hookLocale: hookScope.locale,
    },
  };
}
