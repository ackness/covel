import { buildTurnDigest } from "./turn-digest.js";
/**
 * TurnExecutor — orchestrates a complete turn execution.
 *
 * Pipeline: Input → Trigger Filter → Schedule → [For each group: Context → LLM → Validate] → Result
 *
 * Note: RuntimeOutput is intentionally Record<string, unknown> — plugins produce
 * arbitrary output shapes. The session kernel normalizes them into typed Proposals.
 */

import { DEFAULT_MAX_TOOL_STEPS } from "../agent-loop/agent-loop-policy.js";

import { getTurnExecutionSignal } from "../turn-executor/turn-control.js";
import type {
  DeferredRuntimeJob,
  RuntimeManifest,
  RuntimeResult,
  SchedulingDiagnostic,
  TurnInput,
  TurnResult,
} from "@covel/shared";
import {
  DEFAULT_LOCALE,
  isSetupRuntime,
  resolveSetupGeneration,
} from "@covel/shared";
import { executeParallel } from "../schedule/parallel-executor.js";
import type { ParallelRuntimeIdentity } from "../schedule/parallel-executor.js";
import { scheduleByDag } from "../schedule/dag-scheduler.js";
import {
  applyHazardPolicy,
  resolveEffectsPolicy,
} from "../schedule/effects.js";
import {
  runTurnStartHook,
  runTurnStopHook,
  runPreScheduleHook,
  runPreCompactionHook,
  runPostCompactionHook,
} from "../hooks/wire-helpers.js";
import { emitSubEvent } from "./turn-runtime-helpers.js";
import { __testOnly_parseFinalOutputEnvelope } from "./turn-output-helpers.js";
import { executeOneRuntime } from "./turn-runtime-execution.js";
import type { RuntimeInvocation } from "./turn-runtime-execution.js";
import {
  makeSkippedResult,
  retainPreGameRuntimes,
} from "./turn-executor-helpers.js";
import { collectSetupRan, detectSetupSessionCycles } from "./setup-run.js";
import { SetupCompletionTracker } from "./setup-completion-tracker.js";
import { updateSetupRuntimeStates } from "../commit/session-clock.js";
import {
  buildHookSettings,
  snapshotUserSettings,
} from "../hooks/hook-settings.js";
import { runWithHookScope } from "../hooks/hook-scope.js";
import { runEventChain } from "../trigger/turn-event-chain.js";
import {
  type RecursiveTurnInput,
  type TurnExecutorDeps,
  type TurnExecutorOptions,
} from "./turn-executor-types.js";
import { finalizeTurnResult } from "./turn-result-finalizer.js";
import { attachExecutionJournal } from "../execution-journal.js";
import {
  applySessionPhaseCountPolicy,
  createExecutionContext,
} from "./execution-context.js";
import {
  isTurnExecutionAborted,
  PLAYER_ABORT_REASON,
  trackSteeringReaders,
} from "./turn-control.js";
import {
  detachedUpstreamResults,
  planTurnDetachment,
} from "../schedule/turn-completion.js";
import { DIMENSION_CONTRACT } from "@covel/shared";
import {
  DIMENSION_SNAPSHOT_SKIP,
  dimensionExecutionBarrier,
} from "./dimension-barrier.js";
import {
  createWorldModelView,
  memoizeWorldModelReads,
} from "../function-runtime/world-model-view.js";
import {
  loadSessionSummaries,
  refreshSessionContextSnapshot,
} from "./session-context.js";
import {
  buildProjectedPromptHistory,
  getPreGameRuntimeState,
  loadTurnSessionState,
  type LoadedTurnSessionState,
} from "./session-state.js";
import {
  isScopedRuntimeRecovery,
  scheduleTriggeredRuntimes,
  selectTriggeredRuntimes,
} from "./scheduling.js";

export {
  __testOnly_parseFinalOutputEnvelope,
  looksLikeStructuredRuntimeOutput,
} from "./turn-output-helpers.js";
export {
  MaxRecursionExceeded,
  type AgentLoopDeps,
  type TurnExecutorDeps,
  type TurnExecutorOptions,
} from "./turn-executor-types.js";
export {
  resumeSuspendedRuntime,
  type ResumeSuspendedRuntimeOptions,
} from "../resume/turn-resume.js";

// ── Implementation ───────────────────────────────────────────────

/**
 * Execute a complete turn through the full pipeline: trigger filtering,
 * stage/DAG scheduling, context assembly, LLM calls with tool loops, and
 * result collection.
 *
 * Triggered runtimes run in their stage band (`setup` while the session is in
 * setup; otherwise `pre-turn → narrative → post-turn → audit` with a barrier
 * between stages). Inside a stage, `needs` / `after` / `inputs` edges form a
 * DAG whose independent runtimes run in parallel. Writes stay buffered as
 * proposals for the caller to commit.
 *
 * @param input - Player's turn input (session ID, turn ID, player message).
 * @param activeRuntimes - All active `RuntimeManifest` entries for this session.
 * @param deps - External dependencies: LLM adapter, runtime loader, store, tool executor, config resolver.
 * @param options - Optional execution limits (`maxSteps` for tool-calling loops, `timeoutMs` per runtime).
 * @returns The aggregated `TurnResult` containing all runtime results, pending inputs, and timing info.
 *
 * @example
 * ```typescript
 * import { executeTurn } from '@covel/runtime';
 *
 * const result = await executeTurn(
 *   { sessionId: 'sess-1', turnId: 'turn-1', playerMessage: 'Go north' },
 *   activeManifests,
 *   { loadRuntime, llm, store, toolExecutor },
 * );
 *
 * for (const rr of result.runtimeResults) {
 *   console.log(rr.pluginId, rr.status);
 * }
 * ```
 */
export async function executeTurn(
  input: TurnInput,
  activeRuntimes: readonly RuntimeManifest[],
  deps: TurnExecutorDeps,
  options?: TurnExecutorOptions,
): Promise<TurnResult> {
  // Publish the session's active plugin set so the global HookPipeline only
  // fires hooks of plugins active in this session (see hooks/hook-scope.ts).
  // Capture a turn-level, per-plugin read-only settings snapshot alongside the
  // active set, so hooks can read their own plugin's `userSettings` via
  // `HookContext.getOwnSettings`. Purely additive: when no plugin declares
  // settings the snapshot is empty and behaviour is unchanged.
  const userSettings = snapshotUserSettings(input.userSettings);
  const hookScope = deps.hookScope ?? {
    activePluginIds: new Set(activeRuntimes.map((r) => r.pluginId)),
    settings: buildHookSettings(activeRuntimes, userSettings),
  };
  return runWithHookScope(
    { ...hookScope, locale: hookScope.locale ?? input.locale },
    () =>
      executeTurnImpl(
        { ...input, userSettings },
        activeRuntimes,
        deps,
        options,
      ),
  );
}

async function executeTurnImpl(
  input: TurnInput,
  activeRuntimes: readonly RuntimeManifest[],
  deps: TurnExecutorDeps,
  options?: TurnExecutorOptions,
): Promise<TurnResult> {
  const startTime = Date.now();
  // Frozen execution-start instant: pins `atOrBefore` on every recordAs export
  // read so this execution sees a stable snapshot of committed exports even if a
  // producer publishes a new revision while the turn is still running (02 §3.4.2).
  const executionStartedAt =
    input.detachedStage?.sourceExecutionStartedAt ?? new Date().toISOString();
  const maxSteps = options?.maxSteps ?? DEFAULT_MAX_TOOL_STEPS;
  const defaultTimeoutMs = options?.timeoutMs ?? 60000;
  const recursionDepth = options?.recursionDepth ?? 0;
  const targetedRuntimeId =
    input.detachedStage?.runtimeId ?? input.manualTrigger?.runtimeId;
  const batchRuntimeIds = input.manualTrigger?.runtimeIds;
  const scopedRecovery = isScopedRuntimeRecovery(input);
  const targetedRuntimeIds = new Set(
    batchRuntimeIds ?? (targetedRuntimeId ? [targetedRuntimeId] : []),
  );
  const isTargeted = Boolean(input.manualTrigger || input.detachedStage);
  // Allocate identity before hooks run. Counting stays conservative until the
  // authoritative persisted session phase is loaded below.
  let executionContext = createExecutionContext(input);
  const executionFlags = input as RecursiveTurnInput;
  const shouldAppendPlayerMessage =
    !input.manualTrigger &&
    !input.detachedStage &&
    !executionFlags.suppressPlayerMessage &&
    input.playerMessage.length > 0;

  // Emit turn.started — when a manual trigger drove this turn we tag the
  // event with the runtime + plugin id so observability surfaces (the
  // /debug page in particular) can distinguish a player-driven story turn
  // from an out-of-band plugin-rpc invocation that happens to share the
  // same event pipeline.
  emitSubEvent(deps.eventBus, "game", "turn.started", input.sessionId, {
    turnId: input.turnId,
    sessionId: input.sessionId,
    ...(input.manualTrigger
      ? {
          manualTrigger: {
            ...(batchRuntimeIds
              ? { runtimeIds: batchRuntimeIds }
              : {
                  runtimeId: targetedRuntimeId,
                  pluginId: targetedRuntimeId?.split("/")[0],
                }),
            ...(input.manualTrigger.sourceTurnId
              ? { sourceTurnId: input.manualTrigger.sourceTurnId }
              : {}),
          },
        }
      : {}),
  });

  // ── TurnStart hook ───────────────────────────────────
  {
    const tsResult = await runTurnStartHook(
      {
        pipeline: deps.hookPipeline,
        signal: getTurnExecutionSignal(deps.turnControl),
        sessionId: input.sessionId,
        turnId: input.turnId,
        eventBus: deps.eventBus,
        emitter: deps.emitter,
      },
      {
        playerMessage: input.playerMessage,
        activeRuntimes: activeRuntimes.map((r) => r.name),
      },
    );
    if (tsResult.action === "abort") {
      return {
        turnId: input.turnId,
        sessionId: input.sessionId,
        runtimeResults: [],
        executionContext,
        durationMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
        abortReason: tsResult.reason,
      };
    }
  }

  let sessionState: LoadedTurnSessionState;
  try {
    sessionState = await loadTurnSessionState({
      input,
      deps,
      shouldAppendPlayerMessage,
    });
  } catch (error) {
    if (!deps.turnControl?.signal?.aborted) throw error;
    return {
      turnId: input.turnId,
      sessionId: input.sessionId,
      runtimeResults: [],
      executionContext,
      durationMs: Date.now() - startTime,
      timestamp: new Date().toISOString(),
      abortReason: PLAYER_ABORT_REASON,
    };
  }
  executionContext = applySessionPhaseCountPolicy(
    executionContext,
    sessionState.phase,
  );
  const {
    messageHistory,
    journalMessages,
    runtimeTriggerCounts,
    runtimeTurnsSinceLastTrigger,
    sessionStatus,
    turnNumber,
  } = sessionState;
  // Logical-turn number for this execution (frozen): the count of committed
  // main-loop player turns plus one. Drives scheduled cadence / startTurn and
  // is independent of the raw player-message count `turnNumber`.
  // A detached job keeps the number of the execution that queued it.
  const logicalTurn =
    input.detachedStage?.sourceLogicalTurn ??
    sessionState.completedPlayerTurns + 1;
  const dimensionBarrier = await dimensionExecutionBarrier({
    store: deps.store,
    sessionId: input.sessionId,
    runtimes: activeRuntimes,
    willNarrate: activeRuntimes.some(
      (runtime) =>
        runtime.outputKind === "story" &&
        (!isTargeted || targetedRuntimeIds.has(runtime.name)),
    ),
  });
  if (dimensionBarrier)
    return {
      turnId: input.turnId,
      sessionId: input.sessionId,
      runtimeResults: [],
      executionContext,
      durationMs: Date.now() - startTime,
      timestamp: new Date().toISOString(),
      abortReason: dimensionBarrier,
    };
  const dimensionProvider = activeRuntimes.find(
    (runtime) => runtime.outputContract === DIMENSION_CONTRACT,
  );
  deps = { ...deps, dimensionProviderPluginId: dimensionProvider?.pluginId };
  // Abort early if session is paused or ended — no runtimes should execute.
  if (sessionStatus !== "active") {
    return {
      turnId: input.turnId,
      sessionId: input.sessionId,
      runtimeResults: [],
      executionContext,
      durationMs: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    };
  }

  let sessionMeta = sessionState.sessionMeta;
  const activeSetupRuntimes = activeRuntimes.filter(isSetupRuntime);
  const { preGameRuntimes, isPreGamePending } = getPreGameRuntimeState(
    activeRuntimes,
    sessionState.phase,
  );
  // Single owner of setup-completion state for this execution: the setup-band
  // mirror frozen at execution start (drives setup scheduling by
  // pending/blocked rather than turn cadence, the attempt-ledger generation,
  // and the implicit per-plugin session gate), the live done-set, the
  // newly-done delta, the all-done flag, and the observed flag gating
  // `TurnResult.setupCompletion`. See setup-completion-tracker.ts.
  const setupTracker = new SetupCompletionTracker({
    activeSetupRuntimes,
    setupRuntimes: sessionState.setupRuntimes,
    preGameRuntimes,
    isPreGamePending,
    isManualTrigger: input.manualTrigger !== undefined,
  });
  const pluginSetupReady = setupTracker.pluginSetupReady;

  // Setup session-gate SCC: a `needs(scope: session)` cycle among pending setup
  // runtimes can never resolve (a session-scope need reads a PERSISTED done
  // state), so block the members up front — no run, no attempt burned. Guarded
  // so real plugins (none declare such an edge) pay nothing.
  {
    const cycles = detectSetupSessionCycles(
      activeSetupRuntimes,
      setupTracker.mirror,
    );
    if (cycles.size > 0 && !isTargeted) {
      const now = new Date().toISOString();
      const blocked = setupTracker.blockSessionCycles(cycles, now);
      if (deps.store) {
        await updateSetupRuntimeStates(
          deps.store,
          input.sessionId,
          now,
          () => blocked,
        );
      }
    }
  }
  // Committed world-model state is fixed from here until finalize; every
  // runtime in this execution shares one read of it.
  if (deps.store && !deps.worldModelReads)
    deps = { ...deps, worldModelReads: memoizeWorldModelReads(deps.store) };
  if (deps.extensions) {
    deps = {
      ...deps,
      extensionExecution: deps.extensions.createExecution({
        emitter: deps.emitter,
        runtimeIdentities: activeRuntimes,
        sessionId: input.sessionId,
        turnId: input.turnId,
        locale: input.locale ?? DEFAULT_LOCALE,
        world: deps.store
          ? await createWorldModelView(
              deps.worldModelReads ?? deps.store,
              input.sessionId,
            )
          : { characterSchema: null, characters: [], dimensions: {} },
        signal:
          getTurnExecutionSignal(deps.turnControl) ??
          new AbortController().signal,
        gateway: deps.gateway,
        utils: deps.utils,
        readPluginData: async (pluginId, namespace) =>
          (await deps.store?.listPluginData(
            input.sessionId,
            pluginId,
            namespace,
          )) ?? [],
      }),
    };
  }
  const projectedPromptHistory = await buildProjectedPromptHistory({
    input,
    deps,
    messageHistory,
  });
  const { manualTarget, manualTargets, triggered, abortReason } =
    selectTriggeredRuntimes({
      activeRuntimes,
      manualRuntimeId: targetedRuntimeId,
      manualRuntimeIds: batchRuntimeIds,
      runtimeTriggerCounts,
      runtimeTurnsSinceLastTrigger,
      setupRuntimes: setupTracker.mirror,
      sessionId: input.sessionId,
      turnNumber,
      logicalTurn,
    });
  if (abortReason) {
    return {
      turnId: input.turnId,
      sessionId: input.sessionId,
      runtimeResults: [],
      executionContext,
      durationMs: Date.now() - startTime,
      timestamp: new Date().toISOString(),
      abortReason,
    };
  }

  // PreSchedule hook — plugins may observe / narrow the set of runtimes that
  // run this turn (after trigger selection, before scheduling). No-op when no
  // pipeline or no handler returns a replacement.
  const preScheduleResult = await runPreScheduleHook(
    {
      pipeline: deps.hookPipeline,
      signal: getTurnExecutionSignal(deps.turnControl),
      sessionId: input.sessionId,
      turnId: input.turnId,
      eventBus: deps.eventBus,
      emitter: deps.emitter,
    },
    { triggered },
  );
  // Guard: PreSchedule must not be able to drop Pre-Game runtimes —
  // removing pregame / schema-gen / player-init would silently break session
  // initialization (no character, schema never written, Pre-Game never
  // completes). While Pre-Game is pending, force-retain any triggered Pre-Game
  // runtime the hook dropped; PreSchedule can only shape main-loop runtimes.
  // The `!== triggered` check keeps the no-hook fast path byte-identical.
  const scheduledRuntimes =
    isPreGamePending && preScheduleResult !== triggered
      ? retainPreGameRuntimes(preScheduleResult, triggered)
      : preScheduleResult;

  // 2. Schedule runtimes (stage-driven).
  //
  // Setup stage (`phase: setup`): the `stage === "setup"` runtimes, ordered by
  // declared DAG edges. Plugin manifests own every dependency and ordering
  // decision; the framework adds no plugin-specific chain.
  //
  // Main loop: one DAG per stage (pre-turn → narrative → post-turn → audit),
  // concatenated in stage order so the executor's sequential group loop is the
  // strict barrier. Within a stage the DAG parallelises independent branches
  // (narrator's downstreams run concurrently instead of serialised by number).
  // A cycle disables its SCC + downstream rather than falling back to a sort.
  //
  // See packages/runtime/src/schedule/dag-scheduler.ts for the algorithm.
  const { groups: scheduledGroups, cyclic } = scheduleTriggeredRuntimes({
    manualTarget,
    manualTargets,
    triggered: scheduledRuntimes,
    isPreGamePending,
  });

  // Same-layer effects hazard policy (01 §7): derive read/write sets for each
  // parallel group and check pairs. Default `warn` keeps the groups parallel and
  // only emits diagnostics (no behaviour change); `strict` splits conflicting
  // pairs into serial sub-levels. Single-runtime groups (manual trigger) are a
  // no-op.
  const emitHazardDiagnostics = (
    diagnostics: readonly SchedulingDiagnostic[],
  ): void => {
    for (const d of diagnostics) {
      console.warn(`[covel:warn] [turn-executor] ${d.message}`);
      emitSubEvent(
        deps.eventBus,
        "runtime",
        "scheduling.hazard",
        input.sessionId,
        {
          code: d.code,
          message: d.message,
          ...(d.data !== undefined ? { data: d.data } : {}),
        },
      );
    }
  };
  const { groups, diagnostics: hazardDiagnostics } = applyHazardPolicy(
    scheduledGroups,
    resolveEffectsPolicy(),
  );
  emitHazardDiagnostics(hazardDiagnostics);
  const detachmentPlan =
    input.detachedStage || scopedRecovery
      ? { eligibleRuntimeIds: new Set<string>(), diagnostics: [] }
      : planTurnDetachment(scheduledRuntimes);
  for (const diagnostic of detachmentPlan.diagnostics) {
    const message = `runtime "${diagnostic.runtimeId}" remains in the foreground: ${diagnostic.reason}`;
    console.warn(`[covel:warn] [turn-executor] ${message}`);
    emitSubEvent(
      deps.eventBus,
      "runtime",
      "scheduling.hazard",
      input.sessionId,
      {
        code: "detached-runtime-ineligible",
        message,
        data: { runtimeId: diagnostic.runtimeId },
      },
    );
  }
  const sessionSummaries = await loadSessionSummaries({ input, deps });
  const loadSessionContext = () =>
    refreshSessionContextSnapshot({
      input,
      deps,
      turnNumber,
      sessionSummaries,
      sessionState,
    });
  let sessionContext = await loadSessionContext();
  if (dimensionProvider)
    deps = {
      ...deps,
      dimensionContext: {
        dimensions: sessionContext!.world?.dimensions ?? {},
        dimensionProviderPluginId: dimensionProvider.pluginId,
      },
    };

  // Compaction needs the real assembled system prompt to make a meaningful
  // threshold decision. The first agent runtime reading the shared history
  // view supplies that preview after assembly (runtimes with a declared
  // history window skip it); all such agents share this promise so hooks and
  // the compactor run at most once per turn. The current player message stays
  // in the execution journal and cannot enter a summary before commit.
  let compactionPreparation:
    | Promise<{
        readonly compacted: boolean;
        readonly messageHistory: readonly import("@covel/store").TurnMessageRecord[];
        readonly sessionSummaries: readonly import("@covel/store").SessionSummaryRecord[];
      }>
    | undefined;
  const prepareCompactedContext = (systemPromptPreview: string) => {
    if (!compactionPreparation) {
      compactionPreparation = (async () => {
        const unchanged = {
          compacted: false,
          messageHistory: projectedPromptHistory,
          sessionSummaries,
        } as const;
        if (!deps.compactor || !deps.store || !shouldAppendPlayerMessage) {
          return unchanged;
        }

        const hookOpts = {
          pipeline: deps.hookPipeline,
          signal: getTurnExecutionSignal(deps.turnControl),
          sessionId: input.sessionId,
          turnId: input.turnId,
          eventBus: deps.eventBus,
          emitter: deps.emitter,
        };
        const pre = await runPreCompactionHook(hookOpts, {
          messageCount: projectedPromptHistory.length,
        });
        if (pre.skip) return unchanged;

        const result = await deps.compactor.run(
          input.sessionId,
          systemPromptPreview,
          projectedPromptHistory,
          input.locale,
          deps.emitter?.traceId,
          deps.emitter,
          getTurnExecutionSignal(deps.turnControl),
        );
        await runPostCompactionHook(hookOpts, {
          compacted: result.compacted,
          ...(result.summaryId ? { summaryId: result.summaryId } : {}),
        });
        if (!result.compacted) return unchanged;

        const [freshMessages, freshSummaries] = await Promise.all([
          deps.store.listUncompactedTurnMessages(input.sessionId),
          deps.store.listSessionSummaries(input.sessionId),
        ]);
        return {
          compacted: true,
          messageHistory: await buildProjectedPromptHistory({
            input,
            deps,
            messageHistory: freshMessages,
          }),
          sessionSummaries: freshSummaries,
        };
      })();
    }
    return compactionPreparation;
  };

  // 3. Execute each group
  const completedResults = new Map<string, RuntimeResult>();
  const deferredRuntimeJobs: DeferredRuntimeJob[] = [];

  // Retry seeding (manual retry of a failed runtime): pre-populate the map
  // with the original turn's recorded outputs so the target's `input.inject`
  // and `needs` resolve against them. Tracked by object identity so the
  // pre-finalize cleanup below drops any seed that a real execution did not
  // overwrite this turn.
  const retrySeeds = new Map<string, RuntimeResult>();
  const seededResults =
    input.detachedStage?.upstreamResults ??
    input.manualTrigger?.retrySeedResults ??
    [];
  for (const seed of seededResults) {
    if (targetedRuntimeIds.has(seed.runtimeId)) continue;
    completedResults.set(seed.runtimeId, seed);
    retrySeeds.set(seed.runtimeId, seed);
  }

  // Manual-trigger turns can carry an optional `triggerEvent` payload — used
  // by the plugin-rpc background follower path so a deferred follower runtime
  // receives the same `ctx.triggerEvent` shape it would have seen during the
  // synchronous event-chain fan-out. Undefined for everyone else.
  const manualTriggerEventPayload = manualTarget
    ? input.manualTrigger?.triggerEvent
    : undefined;

  // Nested `ctx.recursiveCall` executions bubble their runtime results
  // here so the commit-owning caller can process their proposals through the
  // same barrier as top-level results.
  const nestedRuntimeResults: RuntimeResult[] = [];

  // The runtimes of this execution that read the player's interjections. The
  // queue closes when the last of them settles, so a later `/steer` is refused
  // instead of accepted with no model call left to read it. A nested execution
  // leaves the queue to its top-level execution.
  const steeringReaders = trackSteeringReaders({
    control: recursionDepth === 0 ? deps.turnControl : undefined,
    scheduled: [
      ...(isPreGamePending || isTargeted
        ? []
        : scheduledRuntimes.filter(isSetupRuntime)),
      ...groups.flatMap((group) => group.runtimes),
    ].filter((rt) => !detachmentPlan.eligibleRuntimeIds.has(rt.name)),
    eventFollowers: scopedRecovery
      ? []
      : activeRuntimes.filter((rt) => rt.trigger?.type === "event"),
  });

  // Single entry point for invoking one runtime. `sessionMeta` / `sessionContext`
  // are reassigned by recordPreGameCompletion between call sites, so this reads
  // them by closure each call rather than snapshotting a base object.
  const invoke = (
    manifest: RuntimeManifest,
    triggerEvent: RuntimeInvocation["triggerEvent"],
    identity?: ParallelRuntimeIdentity,
  ): Promise<RuntimeResult> => {
    // A provider that ran and did not publish blocks narration. One that was
    // not scheduled (a targeted manual run or retry) only republishes
    // committed values, which `deps.dimensionContext` already froze.
    const providerStatus = dimensionProvider
      ? completedResults.get(dimensionProvider.name)?.status
      : undefined;
    if (
      manifest.outputKind === "story" &&
      providerStatus !== undefined &&
      providerStatus !== "success"
    ) {
      steeringReaders.settled(manifest.name);
      return Promise.resolve(
        makeSkippedResult(
          manifest,
          input,
          DIMENSION_SNAPSHOT_SKIP.reason,
          DIMENSION_SNAPSHOT_SKIP.by,
          {},
        ),
      );
    }
    return executeOneRuntime({
      manifest,
      input,
      activeRuntimes,
      completedResults,
      deps,
      maxSteps,
      defaultTimeoutMs,
      messageHistory: projectedPromptHistory,
      sessionMeta,
      hookPipeline: deps.hookPipeline,
      sessionSummaries,
      ...(deps.compactor && deps.store && shouldAppendPlayerMessage
        ? { prepareCompactedContext }
        : {}),
      sessionContext,
      triggerEvent,
      turnOptions: options,
      executeTurnFn: executeTurn,
      recursionDepth,
      executionId: executionContext.executionId,
      executionContext,
      ...(identity ? { runId: identity.runId } : {}),
      executionStartedAt,
      pluginSetupReady,
      setupRuntimeDone: (runtimeId) =>
        setupTracker.isSetupRuntimeDone(runtimeId),
      ...(isSetupRuntime(manifest)
        ? {
            setupGeneration: resolveSetupGeneration(
              manifest.version,
              setupTracker.mirror[manifest.name],
            ),
          }
        : {}),
      collectNestedResults: (results) => {
        nestedRuntimeResults.push(...results);
      },
    }).finally(() => steeringReaders.settled(manifest.name));
  };

  // Player abort — stop scheduling further groups/followers as soon as
  // the signal fires. The in-flight runtime is cut by the loop/retry layer;
  // its result surfaces as failed with a turn-aborted message and carries no
  // PROPOSALS, so nothing proposal-shaped is committed.
  //
  // The builtin character tools and core-memory update tool both return
  // proposals, so their writes are discarded with the aborted result. Plugin
  // data writes — including deletes (`set(key, null)`) — are proposal-backed on
  // every execution path as well: handlers write through the per-execution
  // write buffer (function-runtime/turn-function-runtime.ts) and deletes use
  // their own proposal in the same transaction
  // (function-runtime/plugin-handler-helpers.ts), so an abort discards them
  // too. Unbuffered direct writes exist only in the standalone test-runtime
  // API, never inside executeTurn.
  const playerAborted = (): boolean =>
    deps.turnControl?.signal?.aborted === true;
  const executionAborted = (): boolean =>
    isTurnExecutionAborted(deps.turnControl);

  // Disable a dependency-cycle SCC (and everything downstream of it): mark each
  // member skipped rather than falling back to a plain priority sort. The rest
  // of the schedule runs normally. `cyclePath` carries the full stuck set for
  // diagnosis. Reused for the pre-game-followup DAG below.
  const emitCyclicSkips = (members: readonly RuntimeManifest[]): void => {
    if (members.length === 0) return;
    const cyclePath = members.map((m) => m.name);
    for (const m of members) {
      if (completedResults.has(m.name)) continue;
      completedResults.set(
        m.name,
        makeSkippedResult(
          m,
          input,
          "dependency-cycle",
          "framework:dependencyCycle",
          { cyclePath },
        ),
      );
    }
  };

  // Late-setup pass (playing phase): a plugin enabled after the session left the
  // setup phase has pending setup runtimes the main-loop stages exclude. Run them
  // BEFORE the main groups — as a pre-turn catch-up layer — so their plugin's
  // main runtimes gate on this turn's fresh result. Same declared-edge setup
  // DAG as the setup phase. Blocked / done setup runtimes were already
  // filtered out by selectTriggeredRuntimes.
  if (!isPreGamePending && !isTargeted && !executionAborted()) {
    const lateSetup = scheduledRuntimes.filter((rt) => isSetupRuntime(rt));
    const lateSetupPlan = scheduleByDag(lateSetup);
    // Same-layer effects hazard policy as the main groups (01 §7): late-setup
    // runs parallel groups too, so it must not bypass conflict diagnostics or
    // the strict policy's serial sub-levels.
    const { groups: lateSetupGroups, diagnostics: lateSetupHazards } =
      applyHazardPolicy(lateSetupPlan.groups, resolveEffectsPolicy());
    emitHazardDiagnostics(lateSetupHazards);
    // planTurnDetachment does not filter by stage, so a setup runtime declaring
    // `turnCompletion: detached` can be marked eligible. The late-setup channel
    // has no deferred-job path (enqueueing happens only in the main group loop
    // below), so it deliberately IGNORES the declaration and runs such
    // runtimes in the foreground — with a diagnostic so the deviation from the
    // manifest is observable instead of silent.
    for (const manifest of lateSetup) {
      if (!detachmentPlan.eligibleRuntimeIds.has(manifest.name)) continue;
      const message = `setup runtime "${manifest.name}" declares turnCompletion: detached, but the late-setup channel runs it in the foreground (no deferred job path)`;
      console.warn(`[covel:warn] [turn-executor] ${message}`);
      emitSubEvent(
        deps.eventBus,
        "runtime",
        "scheduling.hazard",
        input.sessionId,
        {
          code: "detached-setup-runtime-foreground",
          message,
          data: { runtimeId: manifest.name },
        },
      );
    }
    for (const group of lateSetupGroups) {
      if (executionAborted()) break;
      const results = await executeParallel(
        group.runtimes,
        (manifest, identity) => invoke(manifest, undefined, identity),
        input.turnId,
      );
      for (const [name, result] of results) completedResults.set(name, result);
    }
    emitCyclicSkips(lateSetupPlan.cyclic ?? []);
    setupTracker.syncLiveDone(completedResults);
  }

  for (const group of groups) {
    if (executionAborted()) break;
    // A detached runtime observes the same visible set it would have seen at
    // the start of this DAG level. Results from foreground siblings in this
    // level are deliberately excluded because they used to run in parallel.
    const frozenUpstreamResults = [...completedResults.values()];
    const foregroundRuntimes = group.runtimes.filter(
      (manifest) => !detachmentPlan.eligibleRuntimeIds.has(manifest.name),
    );
    for (const manifest of group.runtimes) {
      if (!detachmentPlan.eligibleRuntimeIds.has(manifest.name)) continue;
      deferredRuntimeJobs.push({
        jobId: crypto.randomUUID(),
        runtimeId: manifest.name,
        pluginId: manifest.pluginId,
        sourceTurnId: input.turnId,
        sourceExecutionId: executionContext.executionId,
        sourceExecutionStartedAt: executionStartedAt,
        sourceLogicalTurn: logicalTurn,
        ...(executionContext.logicalTurnId
          ? { sourceLogicalTurnId: executionContext.logicalTurnId }
          : {}),
        ...(manifest.version ? { pluginVersion: manifest.version } : {}),
        upstreamResults: detachedUpstreamResults(
          manifest,
          frozenUpstreamResults,
          activeRuntimes,
        ),
        turnDigest: buildTurnDigest(
          input,
          frozenUpstreamResults,
          activeRuntimes,
          sessionMeta.lastPlayerInput,
        ),
      });
    }
    const results = await executeParallel(
      foregroundRuntimes,
      async (manifest, identity) => {
        const triggerEventForRuntime =
          manualTarget &&
          manualTriggerEventPayload &&
          manifest.name === manualTarget.name
            ? manualTriggerEventPayload
            : undefined;
        return invoke(manifest, triggerEventForRuntime, identity);
      },
      input.turnId,
    );

    // Merge results
    for (const [name, result] of results) {
      completedResults.set(name, result);
    }
  }
  emitCyclicSkips(cyclic);

  // Record setup completion before the event chain and finalizer read the
  // mirror delta. Deliberate change (turn-wide transaction): a
  // request that finishes the last Pre-Game runtime no longer runs the main
  // loop in the SAME execution — the setup execution commits on its own and
  // the narrator (and other main-loop runtimes) run in a SEPARATE execution
  // once the finalize transaction has flipped the band to `playing`. Same-batch
  // followups read guard/setup writes that were not yet committed, which the
  // whole-turn transaction no longer permits. The actions route bridges the
  // player-visible gap: after this execution commits it chains one main-loop
  // turn on the same request (opening continuation), so the opening narrative
  // still arrives without an extra player message.
  if (isPreGamePending) setupTracker.recordPreGameCompletion(completedResults);

  // Drop retry seeds BEFORE the event fan-out and the finalizer: seeds are
  // inject/needs context for the retried runtime only. runEventChain collects
  // `effects.events` from every completedResults entry — leaving seeds in
  // would REPLAY the original turn's events (scene.set, receipts, generation
  // requests) on every retry. Seeds a real execution overwrote stay.
  for (const [name, seed] of retrySeeds) {
    if (completedResults.get(name) === seed) completedResults.delete(name);
  }

  // Recovery events remain in the target's result without rerunning subscribers.
  const deferredFollowers =
    executionAborted() || scopedRecovery
      ? []
      : await runEventChain({
          activeRuntimes,
          completedResults,
          executeRuntime: (manifest, triggerEvent, identity) =>
            invoke(manifest, triggerEvent, identity),
          sessionId: input.sessionId,
          turnId: input.turnId,
          turnNumber,
          logicalTurn,
          // Fan-out is the only place an `event` runtime can trigger, so its
          // throttle gates only work if the real history reaches them. The setup
          // mirror prevents a completed setup runtime from re-firing.
          setupRuntimes: setupTracker.mirror,
          onDroppedEvent: (topic, runtimeId) =>
            emitHazardDiagnostics([
              {
                code: "event-payload-dropped",
                severity: "warn",
                runtimeId,
                message: `event "${topic}" from ${runtimeId} was not delivered: one payload per topic per fan-out depth`,
                data: { topic, runtimeId },
              },
            ]),
          runtimeTriggerCounts,
          runtimeTurnsSinceLastTrigger,
        });
  // No runtime starts after the fan-out, so nothing reads the queue from here.
  steeringReaders.close();

  // ── Pre-Game completion tracking ────────────────────────────────
  //
  // The setup stage runs while the session phase is `setup` and is responsible
  // for one-off initialisation: welcome text, world schema generation, opening
  // character form, etc. A setup runtime is considered
  // "done" when ANY of the following hold:
  //
  //   1. Its successful result reports `completion: "done"`
  //        - Used by runtimes that complete deterministically in one turn
  //          (e.g. `pregame` handler returns `completion: "done"`
  //          after writing the welcome notification).
  //        - Agent protocol `preGameDone: true` is converted to this signal
  //          at the agent output boundary.
  //
  //   2. Its guard returned `{ skip: true }`
  //        - Covers a setup runtime that finds its work already done or
  //          derivable without an LLM (e.g. `world-init/schema-gen` when this
  //          session already holds the schema, or the world package declares
  //          character attributes / dimensions it can import directly).
  //
  // A setup runtime that instead exhausts its retry budget without ever
  // signalling done is NOT marked done — it lands on `blocked` (via the
  // finalize settle), which holds the session in the setup band until the
  // player retries or waives it (deliberate change from the old "advance past a
  // broken setup").
  //
  // The session's setup mirror accumulates these runtime resolutions across
  // turns. Once every active setup runtime is done, the finalizer flips the
  // authoritative phase to `playing`.
  //
  // IMPORTANT: plugins with a form-submission completion signal (like
  // player-init) MUST NOT report completion in the "form shown"
  // turn — they report it only after the player submits the form. This
  // keeps the user interactable while Pre-Game is still progressing.
  //
  // This final pass is intentionally idempotent. The earlier pass above keeps
  // the event chain and finalize reading a fresh Pre-Game / setup-completion
  // state; this one captures completion signals produced by event-chain
  // followers.
  setupTracker.recordPreGameCompletion(completedResults);

  // Ledger entries for every setup runtime that ran this execution (both bands
  // + late-setup), handed to the finalizer for attempt terminalisation and the
  // pending/blocked mirror. The tracker fold also derives done mirrors for any
  // late-setup completion that recordPreGameCompletion did not observe
  // (playing band) and gates `setupCompletion` on observed setup activity.
  const setupRan = collectSetupRan({
    activeRuntimes,
    completedResults,
    setupRuntimes: setupTracker.mirror,
    executionId: executionContext.executionId,
  });
  setupTracker.foldSetupRan(setupRan);

  // A suspended turn is not complete yet: its detached jobs ride with the
  // suspension and are queued when the final resume commits.
  const turnSuspended = [...completedResults.values()].some(
    (result) => result.status === "suspended",
  );
  const canPublishDeferredJobs = !executionAborted() && !turnSuspended;

  const baseResult = await finalizeTurnResult({
    input,
    executionContext,
    startTime,
    completedResults,
    deferredFollowers,
    deferredRuntimeJobs: canPublishDeferredJobs ? deferredRuntimeJobs : [],
    ...(!executionAborted() && turnSuspended
      ? { withheldRuntimeJobs: deferredRuntimeJobs }
      : {}),
    deps,
    turnNumber,
    nestedRuntimeResults,
  });

  const setupCompletion = setupTracker.setupCompletion;
  const turnResult: TurnResult = {
    ...baseResult,
    // Surface the setup delta so the commit-owning caller folds it into the
    // session-clock write (phase flip + setup mirror) atomically with commit.
    // Only present on the non-manual setup path that actually observed it.
    ...(setupCompletion ? { setupCompletion } : {}),
    // Setup attempts to settle (ledger terminalise + pending/blocked mirror)
    // outside the commit transaction. The commit-owning caller forwards this to
    // finalizeExecution.
    ...(setupRan.length > 0 ? { setupRan } : {}),
  };
  attachExecutionJournal(turnResult, journalMessages);

  // ── TurnStop hook — Post* hooks cannot abort ────────
  await runTurnStopHook(
    {
      pipeline: deps.hookPipeline,
      sessionId: input.sessionId,
      turnId: input.turnId,
      eventBus: deps.eventBus,
      emitter: deps.emitter,
    },
    {
      runtimeResults: turnResult.runtimeResults,
      durationMs: turnResult.durationMs,
    },
  );

  if (playerAborted()) {
    return attachExecutionJournal(
      { ...turnResult, abortReason: PLAYER_ABORT_REASON },
      journalMessages,
    );
  }
  return turnResult;
}
