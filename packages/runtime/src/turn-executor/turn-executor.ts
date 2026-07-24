/**
 * TurnExecutor — orchestrates a complete turn execution.
 *
 * Pipeline: Input → Trigger Filter → Schedule → [For each group: Context → LLM → Validate] → Result
 *
 * Note: RuntimeOutput is intentionally Record<string, unknown> — plugins produce
 * arbitrary output shapes. The session kernel normalizes them into typed Proposals.
 */

import type {
  RuntimeManifest,
  RuntimeResult,
  SetupRuntimeState,
  TurnInput,
  TurnResult,
} from "@covel/shared";
import {
  isSetupRuntime,
  mirrorSetupDone,
  resolveSetupGeneration,
} from "@covel/shared";
import { executeParallel } from "../schedule/parallel-executor.js";
import {
  deriveConservativeSetupEdges,
  scheduleByDag,
} from "../schedule/dag-scheduler.js";
import {
  applyHazardPolicy,
  resolveEffectsPolicy,
} from "../schedule/effects.js";
import {
  runTurnStartHook,
  runTurnStopHook,
  runPreScheduleHook,
} from "../hooks/wire-helpers.js";
import { emitSubEvent } from "./turn-runtime-helpers.js";
import {
  __testOnly_parseFinalOutputEnvelope,
  looksLikeStructuredRuntimeOutput,
} from "./turn-output-helpers.js";
import { executeOneRuntime } from "./turn-runtime-execution.js";
import type { RuntimeInvocation } from "./turn-runtime-execution.js";
import {
  makeSkippedResult,
  retainPreGameRuntimes,
  resolveUserSettings,
} from "./turn-executor-helpers.js";
import {
  classifySetupResult,
  collectSetupRan,
  detectSetupSessionCycles,
  initialDoneSetup,
  makePluginSetupReady,
} from "./setup-run.js";
import { runWithHookScope } from "../hooks/hook-scope.js";
import { runEventChain } from "../trigger/turn-event-chain.js";
import {
  MaxRecursionExceeded,
  type RecursiveTurnInput,
  type TurnExecutorDeps,
  type TurnExecutorOptions,
} from "./turn-executor-types.js";
import { finalizeTurnResult } from "./turn-result-finalizer.js";
import { createExecutionContext } from "./execution-context.js";
import { PLAYER_ABORT_REASON } from "./turn-control.js";
import { markPreGameCompletion } from "./pre-game-completion.js";
import { schedulePostTurnMemoryUpdate } from "./post-turn-memory.js";
import {
  loadCoreMemoryBlocks,
  loadSessionSummaries,
  loadWorkingMemory,
  refreshSessionContextSnapshot,
} from "./session-context.js";
import {
  buildProjectedPromptHistory,
  getPreGameRuntimeState,
  loadTurnSessionState,
} from "./session-state.js";
import {
  countPlayerMessagesSinceRuntime,
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
 * priority scheduling, context assembly, LLM calls with tool loops, and result persistence.
 *
 * Each active runtime is evaluated for triggering, then scheduled into priority groups.
 * Groups execute sequentially (lower priority number = earlier), with runtimes in the same
 * group running in parallel. Results are persisted to the store when available.
 *
 * @param input - Player's turn input (session ID, turn ID, player message).
 * @param activeRuntimes - All active `RuntimeManifest` entries for this session, sorted by priority.
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
  const activePluginIds = new Set<string>(
    activeRuntimes.map((r) => r.pluginId),
  );
  // Capture a turn-level, per-plugin read-only settings snapshot alongside the
  // active set, so hooks can read their own plugin's `userSettings` via
  // `HookContext.getOwnSettings`. Purely additive: when no plugin declares
  // settings the snapshot is empty and behaviour is unchanged.
  const settings = buildHookSettings(activeRuntimes, input.userSettings);
  return runWithHookScope({ activePluginIds, settings }, () =>
    executeTurnImpl(input, activeRuntimes, deps, options),
  );
}

/**
 * Build the turn-level per-plugin settings snapshot consumed by hooks.
 *
 * For each active runtime, resolves its `userSettings` (manifest defaults
 * merged with the player's saved values) and merges the result into the
 * owning plugin's bucket. Plugins without declared settings are omitted.
 * Buckets and the top-level map are deep-frozen so hooks can never mutate the
 * snapshot — including nested values. (Current `PluginUserSettingSpec` types
 * only yield scalars, but `spec.default` is typed `unknown`, so a plugin could
 * declare an object default; deep-freezing keeps the read-only contract honest
 * regardless.)
 */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const inner of Object.values(value as Record<string, unknown>)) {
      deepFreeze(inner);
    }
    Object.freeze(value);
  }
  return value;
}

function buildHookSettings(
  activeRuntimes: readonly RuntimeManifest[],
  allUserSettings: TurnInput["userSettings"],
): Readonly<Record<string, Readonly<Record<string, unknown>>>> {
  const snapshot: Record<string, Record<string, unknown>> = {};
  for (const manifest of activeRuntimes) {
    const resolved = resolveUserSettings(manifest, allUserSettings);
    if (!resolved) continue;
    const bucket = snapshot[manifest.pluginId] ?? {};
    Object.assign(bucket, resolved);
    snapshot[manifest.pluginId] = bucket;
  }
  for (const pluginId of Object.keys(snapshot)) {
    deepFreeze(snapshot[pluginId]);
  }
  return Object.freeze(snapshot);
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
  const executionStartedAt = new Date().toISOString();
  const maxSteps = options?.maxSteps ?? 10;
  const defaultTimeoutMs = options?.timeoutMs ?? 60000;
  const recursionDepth = options?.recursionDepth ?? 0;
  // Single creation point for the run's identity. Origin is normalized here
  // (legacy `follower` → `background`) and every kernel read below consults
  // this, not the raw transitional `input.origin`.
  const executionContext = createExecutionContext(input);
  const executionFlags = input as RecursiveTurnInput;
  const shouldAppendPlayerMessage =
    !input.manualTrigger &&
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
            runtimeId: input.manualTrigger.runtimeId,
            ...(input.manualTrigger.runtimeId.includes("/")
              ? { pluginId: input.manualTrigger.runtimeId.split("/")[0] }
              : { pluginId: input.manualTrigger.runtimeId }),
          },
        }
      : {}),
  });

  // ── TurnStart hook ───────────────────────────────────
  {
    const tsResult = await runTurnStartHook(
      {
        pipeline: deps.hookPipeline,
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

  const sessionState = await loadTurnSessionState({
    input,
    deps,
    shouldAppendPlayerMessage,
  });
  const { messageHistory, runtimeTriggerCounts, sessionStatus, turnNumber } =
    sessionState;
  // Logical-turn number for this execution (frozen): the count of committed
  // main-loop player turns plus one. Drives scheduled cadence / startTurn and
  // is independent of the raw player-message count `turnNumber`.
  const logicalTurn = sessionState.completedPlayerTurns + 1;

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
  let preGameCompleted = sessionMeta.preGameCompleted;
  // Setup-band mirror frozen at execution start — drives setup scheduling (by
  // pending/blocked, not turn cadence), the attempt-ledger generation, and the
  // implicit per-plugin session gate below.
  let setupRuntimesSnapshot = sessionState.setupRuntimes;
  const activeSetupRuntimes = activeRuntimes.filter(isSetupRuntime);

  // Setup session-gate SCC: a `needs(scope: session)` cycle among pending setup
  // runtimes can never resolve (a session-scope need reads a PERSISTED done
  // state), so block the members up front — no run, no attempt burned. Guarded
  // so real plugins (none declare such an edge) pay nothing.
  {
    const pendingSetup = activeSetupRuntimes.filter((rt) => {
      const st = setupRuntimesSnapshot[rt.name]?.state;
      return st !== "done" && st !== "blocked";
    });
    const cycles = detectSetupSessionCycles(pendingSetup);
    if (cycles.size > 0 && !input.manualTrigger) {
      const now = new Date().toISOString();
      const patched: Record<string, SetupRuntimeState> = {
        ...setupRuntimesSnapshot,
      };
      for (const [name, path] of cycles) {
        const manifest = activeSetupRuntimes.find((r) => r.name === name);
        const prev = setupRuntimesSnapshot[name];
        patched[name] = {
          state: "blocked",
          pluginVersion: manifest?.version ?? "0.0.0",
          generation: prev?.generation ?? 1,
          attempts: prev?.attempts ?? 0,
          reason: `setup-session-cycle: ${path.join(" → ")}`,
          blockedAt: now,
        };
      }
      setupRuntimesSnapshot = patched;
      if (deps.store) {
        // Setup mirror is the sole write surface; `preGameCompleted` derives
        // from it at read time.
        await deps.store.updateSession(input.sessionId, {
          setupRuntimes: patched,
          updatedAt: now,
        });
      }
    }
  }
  // Live done-set the session gate reads. Seeded from committed state; the
  // late-setup pass adds runtimes that complete within THIS turn so their
  // plugin's main runtimes unblock in the same turn.
  const liveDoneSetup = initialDoneSetup(
    activeSetupRuntimes,
    setupRuntimesSnapshot,
    preGameCompleted,
  );
  const pluginSetupReady = makePluginSetupReady(
    activeSetupRuntimes,
    liveDoneSetup,
  );
  const projectedPromptHistory = await buildProjectedPromptHistory({
    input,
    deps,
    messageHistory,
  });
  const { preGameRuntimes, isPreGamePending } = getPreGameRuntimeState(
    activeRuntimes,
    preGameCompleted,
    sessionState.phase,
  );
  const { manualTarget, triggered, abortReason } = selectTriggeredRuntimes({
    activeRuntimes,
    manualRuntimeId: input.manualTrigger?.runtimeId,
    messageHistory,
    preGameCompleted,
    runtimeTriggerCounts,
    setupRuntimes: setupRuntimesSnapshot,
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
      sessionId: input.sessionId,
      turnId: input.turnId,
      eventBus: deps.eventBus,
      emitter: deps.emitter,
    },
    { triggered },
  );
  // F-1 guard: PreSchedule must not be able to drop Pre-Game runtimes —
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
  // their declared edges plus a conservative legacy-order chain that keeps
  // pregame → schema-gen serial (they have implicit write-ordering with no
  // declared edge). player-init's `needs` order it after both in the same pass.
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
    triggered: scheduledRuntimes,
    isPreGamePending,
  });

  // Same-layer effects hazard policy (01 §7): derive read/write sets for each
  // parallel group and check pairs. Default `warn` keeps the groups parallel and
  // only emits diagnostics (no behaviour change); `strict` splits conflicting
  // pairs into serial sub-levels. Single-runtime groups (manual trigger) are a
  // no-op.
  const { groups, diagnostics: hazardDiagnostics } = applyHazardPolicy(
    scheduledGroups,
    resolveEffectsPolicy(),
  );
  for (const d of hazardDiagnostics) {
    console.warn(`[turn-executor] ${d.message}`);
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
  const sessionSummaries = await loadSessionSummaries({ input, deps });
  // Single listWorkingMemory read per turn: the raw records are threaded into
  // the core-memory manager (initializeDefaults + loadBlocks) below (R-13).
  const { entries: workingMemory, records: workingMemoryRecords } =
    await loadWorkingMemory({ input, deps });
  const coreMemoryBlocks = await loadCoreMemoryBlocks({
    input,
    deps,
    ...(workingMemoryRecords ? { workingMemoryRecords } : {}),
  });
  const loadSessionContext = () =>
    refreshSessionContextSnapshot({
      input,
      deps,
      turnNumber,
      sessionSummaries,
      coreMemoryBlocks,
    });
  let sessionContext = await loadSessionContext();
  const refreshSessionContext = async () =>
    (await loadSessionContext()) ?? sessionContext;

  // 3. Execute each group
  const completedResults = new Map<string, RuntimeResult>();

  // Setup-completion delta accumulated across the (idempotent) completion
  // passes below, handed to the finalizer so the session-clock write (setup
  // mirror + phase flip) lands in the commit transaction. `allSetupDone` tracks
  // the last observed value — once every setup runtime is resolved it stays true.
  const setupNewlyDone: Record<string, SetupRuntimeState> = {};
  let setupAllDone = false;
  let observedSetupCompletion = false;

  // Add every setup runtime that reported done this turn to the live done-set,
  // so a plugin whose setup just completed unblocks its main runtimes within
  // the same turn (the late-setup → main-loop catch-up in the playing band).
  // Idempotent.
  const syncLiveDoneSetup = (): void => {
    for (const rt of activeSetupRuntimes) {
      if (liveDoneSetup.has(rt.name)) continue;
      const result = completedResults.get(rt.name);
      if (result && classifySetupResult(result).doneSignal) {
        liveDoneSetup.add(rt.name);
      }
    }
  };

  const recordPreGameCompletion = async (): Promise<boolean> => {
    const result = await markPreGameCompletion({
      activeRuntimes,
      completedResults,
      deps,
      input,
      isPreGamePending,
      preGameRuntimes,
      preGameCompleted,
      sessionMeta,
      sessionContext,
      refreshSessionContext,
    });
    preGameCompleted = result.preGameCompleted;
    sessionMeta = result.sessionMeta;
    sessionContext = result.sessionContext;
    if (isPreGamePending && !input.manualTrigger) {
      observedSetupCompletion = true;
      Object.assign(setupNewlyDone, result.newlyDone);
      setupAllDone = result.allDone;
    }
    syncLiveDoneSetup();
    return result.allDone;
  };

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

  // Single entry point for invoking one runtime. `sessionMeta` / `sessionContext`
  // are reassigned by recordPreGameCompletion between call sites, so this reads
  // them by closure each call rather than snapshotting a base object.
  const invoke = (
    manifest: RuntimeManifest,
    triggerEvent: RuntimeInvocation["triggerEvent"],
  ): Promise<RuntimeResult> =>
    executeOneRuntime({
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
      workingMemory,
      coreMemoryBlocks,
      sessionContext,
      triggerEvent,
      turnOptions: options,
      executeTurnFn: executeTurn,
      recursionDepth,
      executionId: executionContext.executionId,
      executionContext,
      executionStartedAt,
      pluginSetupReady,
      ...(isSetupRuntime(manifest)
        ? {
            setupGeneration: resolveSetupGeneration(
              manifest.version,
              setupRuntimesSnapshot[manifest.name],
            ),
          }
        : {}),
      collectNestedResults: (results) => {
        nestedRuntimeResults.push(...results);
      },
    });

  // Player abort — stop scheduling further groups/followers as soon as
  // the signal fires. The in-flight runtime is cut by the loop/retry layer;
  // its result surfaces as failed with a turn-aborted message and carries no
  // PROPOSALS, so nothing proposal-shaped is committed.
  //
  // That is not the same as "nothing was written". A few builtin tools write
  // straight to the store instead of returning a proposal — the character
  // tools (create/update-character) and the memory tools (core-memory block
  // updates). Whatever they wrote before the abort is already durable and is
  // NOT rolled back, because it never entered the commit pipeline that the
  // abort short-circuits. The same holds for a runtime that fails after such
  // a call, and for PreStateCommit: a hook cannot veto those writes because
  // they never reach it. Routing them through proposals is the fix; until
  // then this is the honest guarantee.
  const playerAborted = (): boolean =>
    deps.turnControl?.signal?.aborted === true;

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
  // main runtimes gate on this turn's fresh result. Same setup DAG (declared
  // edges + conservative legacy-order chain) as the setup phase. Blocked / done
  // setup runtimes were already filtered out by selectTriggeredRuntimes.
  if (!isPreGamePending && !manualTarget && !playerAborted()) {
    const lateSetup = scheduledRuntimes.filter((rt) => isSetupRuntime(rt));
    const lateSetupPlan = scheduleByDag(
      lateSetup,
      deriveConservativeSetupEdges(lateSetup),
    );
    for (const group of lateSetupPlan.groups) {
      if (playerAborted()) break;
      const results = await executeParallel(group.runtimes, (manifest) =>
        invoke(manifest, undefined),
      );
      for (const [name, result] of results) completedResults.set(name, result);
    }
    emitCyclicSkips(lateSetupPlan.cyclic ?? []);
    syncLiveDoneSetup();
  }

  for (const group of groups) {
    if (playerAborted()) break;
    const results = await executeParallel(group.runtimes, async (manifest) => {
      const triggerEventForRuntime =
        manualTarget &&
        manualTriggerEventPayload &&
        manifest.name === manualTarget.name
          ? manualTriggerEventPayload
          : undefined;
      return invoke(manifest, triggerEventForRuntime);
    });

    // Merge results
    for (const [name, result] of results) {
      completedResults.set(name, result);
    }
  }
  emitCyclicSkips(cyclic);

  // Record Pre-Game completion (updates preGameCompleted / sessionMeta /
  // sessionContext and the setup-completion delta) before the event chain and
  // finalize read them. Deliberate change (turn-wide transaction, Step 2): a
  // request that finishes the last Pre-Game runtime no longer runs the main
  // loop in the SAME execution — the setup execution commits on its own and
  // the narrator (and other main-loop runtimes) run in a SEPARATE execution
  // once the finalize transaction has flipped the band to `playing`. Same-batch
  // followups read guard/setup writes that were not yet committed, which the
  // whole-turn transaction no longer permits. The actions route bridges the
  // player-visible gap: after this execution commits it chains one main-loop
  // turn on the same request (opening continuation), so the opening narrative
  // still arrives without an extra player message.
  if (isPreGamePending) await recordPreGameCompletion();

  const deferredFollowers = playerAborted()
    ? []
    : await runEventChain({
        activeRuntimes,
        completedResults,
        executeRuntime: (manifest, triggerEvent) =>
          invoke(manifest, triggerEvent),
        sessionId: input.sessionId,
        turnNumber,
        logicalTurn,
        // Fan-out is the only place an `event` runtime can trigger, so its
        // throttle gates only work if the real history reaches them. Same for
        // the Pre-Game set: without it a completed setup runtime re-fires
        // whenever its topic is emitted again.
        preGameCompleted,
        runtimeTriggerCounts,
        runtimeTurnsSinceLastTrigger: new Map(
          activeRuntimes.map((rt) => [
            rt.name,
            countPlayerMessagesSinceRuntime(messageHistory, rt.name),
          ]),
        ),
      });

  // ── Pre-Game completion tracking ────────────────────────────────
  //
  // The Pre-Game band (priority 0–99) runs while setup is pending and is
  // responsible for one-off initialisation: welcome text, world schema
  // generation, opening character form, etc. A Pre-Game runtime is considered
  // "done" when ANY of the following hold:
  //
  //   1. Its output reports `preGameDone: true`
  //        - Used by runtimes that complete deterministically in one turn
  //          (e.g. `pregame` handler returns `{ preGameDone: true }`
  //          after writing the welcome notification).
  //        - Also used by runtimes whose guard triggers completion after the
  //          player submits an interactive form (e.g. `char-creator/
  //          player-init` only returns `preGameDone: true` in the guard
  //          branch that observes a submitted character form).
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
  // The session's `preGameCompleted` array accumulates these runtime IDs
  // across turns (important — some plugins require multiple turns to hit
  // their completion signal). When every Pre-Game runtime in the active
  // set is in `preGameCompleted`, the kernel bumps `turnCount` from 0 → 1,
  // moving scheduling into the main-loop band.
  //
  // IMPORTANT: plugins with a form-submission completion signal (like
  // player-init) MUST NOT report `preGameDone: true` in the "form shown"
  // turn — they report it only after the player submits the form. This
  // keeps the user interactable while Pre-Game is still progressing.
  //
  // This final pass is intentionally idempotent. The earlier pass above keeps
  // the event chain and finalize reading a fresh Pre-Game / setup-completion
  // state; this one captures completion signals produced by event-chain
  // followers.
  await recordPreGameCompletion();

  // Ledger entries for every setup runtime that ran this execution (both bands
  // + late-setup), handed to the finalizer for attempt terminalisation and the
  // pending/blocked mirror. Also derive done mirrors for any late-setup
  // completion that markPreGameCompletion did not observe (playing band).
  const setupRan = collectSetupRan({
    activeRuntimes,
    completedResults,
    setupRuntimes: setupRuntimesSnapshot,
    executionId: executionContext.executionId,
  });
  for (const r of setupRan) {
    if (r.doneSignal && !(r.runtimeId in setupNewlyDone)) {
      setupNewlyDone[r.runtimeId] = mirrorSetupDone(
        r.pluginVersion,
        r.startedAt,
      );
    }
  }
  if (setupRan.length > 0) observedSetupCompletion = true;

  const baseResult = await finalizeTurnResult({
    input,
    executionContext,
    startTime,
    completedResults,
    deferredFollowers,
    deps,
    turnNumber,
    nestedRuntimeResults,
  });

  // ── Turn-completion barrier ─────────────────
  // The authoritative `turn.completed` event and post-turn memory ingestion
  // must not fire before the caller commits this turn's proposals — a failed
  // commit would otherwise leave clients with a "completed" turn and memory
  // built from state that never landed. `completeTurn` packages both; the
  // commit-owning caller (actions.ts / plugin-rpc runtime-turn.ts) invokes it
  // once proposals commit. A failed auto-snapshot does NOT withhold it — the
  // snapshot is a best-effort checkpoint, tracked separately on the outcome.
  // Idempotent via the `fired` guard.
  // Memory stays fire-and-forget inside; per-session single-flight lives in
  // the memory updater's pending map.
  let completionFired = false;
  const turnResult: TurnResult = {
    ...baseResult,
    // Surface the setup delta so the commit-owning caller folds it into the
    // session-clock write (phase flip + setup mirror) atomically with commit.
    // Only present on the non-manual setup path that actually observed it.
    ...(observedSetupCompletion
      ? {
          setupCompletion: {
            newlyDone: setupNewlyDone,
            allSetupDone: setupAllDone,
          },
        }
      : {}),
    // Setup attempts to settle (ledger terminalise + pending/blocked mirror)
    // outside the commit transaction. The commit-owning caller forwards this to
    // finalizeExecution.
    ...(setupRan.length > 0 ? { setupRan } : {}),
    completeTurn: () => {
      if (completionFired) return;
      completionFired = true;
      emitSubEvent(deps.eventBus, "game", "turn.completed", input.sessionId, {
        turnId: input.turnId,
        sessionId: input.sessionId,
        durationMs: baseResult.durationMs,
      });
      schedulePostTurnMemoryUpdate({
        input,
        turnResult: baseResult,
        deps,
        coreMemoryBlocks,
      });
    },
  };

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

  return playerAborted()
    ? { ...turnResult, abortReason: PLAYER_ABORT_REASON }
    : turnResult;
}
