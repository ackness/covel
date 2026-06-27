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
  TurnInput,
  TurnResult,
} from "@covel/shared";
import { executeParallel } from "../schedule/parallel-executor.js";
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
  retainPreGameRuntimes,
  resolveUserSettings,
} from "./turn-executor-helpers.js";
import { runWithHookScope } from "../hooks/hook-scope.js";
import { runEventChain } from "../trigger/turn-event-chain.js";
import {
  MaxRecursionExceeded,
  type RecursiveTurnInput,
  type TurnExecutorDeps,
  type TurnExecutorOptions,
} from "./turn-executor-types.js";
import { finalizeTurnResult } from "./turn-result-finalizer.js";
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
  scheduleMainLoopFollowups,
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
 *   { loadRuntime, llm, getConfig: () => ({}), store, toolExecutor },
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
  const maxSteps = options?.maxSteps ?? 10;
  const defaultTimeoutMs = options?.timeoutMs ?? 60000;
  const recursionDepth = options?.recursionDepth ?? 0;
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

  // ── TurnStart hook (S4-T3) ───────────────────────────────────
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

  // Abort early if session is paused or ended — no runtimes should execute.
  if (sessionStatus !== "active") {
    return {
      turnId: input.turnId,
      sessionId: input.sessionId,
      runtimeResults: [],
      durationMs: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    };
  }

  let sessionMeta = sessionState.sessionMeta;
  let preGameCompleted = sessionMeta.preGameCompleted;
  const projectedPromptHistory = await buildProjectedPromptHistory({
    input,
    deps,
    messageHistory,
  });
  const { preGameRuntimes, isPreGamePending } = getPreGameRuntimeState(
    activeRuntimes,
    preGameCompleted,
  );
  const { manualTarget, triggered, abortReason } = selectTriggeredRuntimes({
    activeRuntimes,
    manualRuntimeId: input.manualTrigger?.runtimeId,
    messageHistory,
    preGameCompleted,
    runtimeTriggerCounts,
    sessionId: input.sessionId,
    turnNumber,
  });
  if (abortReason) {
    return {
      turnId: input.turnId,
      sessionId: input.sessionId,
      runtimeResults: [],
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

  // 2. Schedule runtimes.
  //
  // Pre-Game band uses strict priority ordering while setup runtimes are
  // pending: pregame plugins
  // have implicit write-ordering (pregame → world-init/schema-gen → player-init,
  // audit P0-2) that is NOT captured in manifest inject declarations, so
  // falling back to priority is the right semantic. player-init's prompt reads
  // `{{ world.schema }}`, so schema-gen MUST land first in the same setup pass.
  //
  // Main-loop band uses the DAG scheduler after setup completes: it parallelises any
  // runtimes whose declared upstreams (input.inject + upstreamRequired) have
  // already completed. Independent branches (narrator's four downstream
  // plugins — guide/codex/extractor/char-tracker) run concurrently instead
  // of being serialised by numeric priority. Falls back to priority ordering
  // only if a cycle is detected (plugin authoring mistake).
  //
  // See packages/runtime/src/dag-scheduler.ts for the algorithm.
  const groups = scheduleTriggeredRuntimes({
    manualTarget,
    triggered: scheduledRuntimes,
    isPreGamePending,
    turnNumber,
  });
  const sessionSummaries = await loadSessionSummaries({ input, deps });
  const workingMemory = await loadWorkingMemory({ input, deps });
  const coreMemoryBlocks = await loadCoreMemoryBlocks({ input, deps });
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

  const recordPreGameCompletion = async (): Promise<boolean> => {
    const result = await markPreGameCompletion({
      activeRuntimes,
      completedResults,
      deps,
      input,
      isPreGamePending,
      preGameRuntimes,
      preGameCompleted,
      runtimeTriggerCounts,
      sessionMeta,
      sessionContext,
      refreshSessionContext,
    });
    preGameCompleted = result.preGameCompleted;
    sessionMeta = result.sessionMeta;
    sessionContext = result.sessionContext;
    return result.allDone;
  };

  // Manual-trigger turns can carry an optional `triggerEvent` payload — used
  // by the plugin-rpc background follower path so a deferred follower runtime
  // receives the same `ctx.triggerEvent` shape it would have seen during the
  // synchronous event-chain fan-out. Undefined for everyone else.
  const manualTriggerEventPayload = manualTarget
    ? input.manualTrigger?.triggerEvent
    : undefined;

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
    });

  for (const group of groups) {
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

  const completedPreGameThisTurn = isPreGamePending
    ? await recordPreGameCompletion()
    : false;
  if (completedPreGameThisTurn && !manualTarget) {
    // A form-submission request can finish the last Pre-Game runtime. In that
    // same request, immediately run any already-triggered main-loop runtimes so
    // the player sees the first story beat after submitting setup inputs.
    const followupGroups = scheduleMainLoopFollowups({
      triggered: scheduledRuntimes,
      completedRuntimeIds: new Set(completedResults.keys()),
      turnNumber,
    });
    for (const group of followupGroups) {
      const results = await executeParallel(
        group.runtimes,
        async (manifest) => {
          return invoke(manifest, undefined);
        },
      );
      for (const [name, result] of results) {
        completedResults.set(name, result);
      }
    }
  }

  const deferredFollowers = await runEventChain({
    activeRuntimes,
    completedResults,
    executeRuntime: (manifest, triggerEvent) => invoke(manifest, triggerEvent),
    sessionId: input.sessionId,
    turnNumber,
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
  //        - Covers `world-init/schema-gen` when a prior session of
  //          the same world has already generated and persisted schema
  //          + entries; the guard skips the LLM call entirely.
  //
  //   3. It ran out of trigger budget
  //        - Runtimes with `trigger.maxTriggerCount` that have already
  //          hit their cap in a previous turn aren't scheduled again;
  //          they're still recorded as done so they don't block advancement.
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
  // This final pass is intentionally idempotent. The earlier pass above is
  // needed to decide whether to run same-request main-loop followups; this
  // one captures completion signals produced by event-chain followers.
  await recordPreGameCompletion();

  const turnResult = await finalizeTurnResult({
    input,
    startTime,
    completedResults,
    deferredFollowers,
    deps,
    turnNumber,
  });

  // ── Post-turn memory update (Letta-style) ─────────────────────
  // Fire-and-forget: memory update runs asynchronously so it doesn't
  // block the turn response. Stale-by-one-turn is acceptable.
  schedulePostTurnMemoryUpdate({ input, turnResult, deps, coreMemoryBlocks });

  // ── TurnStop hook (S4-T3) — Post* hooks cannot abort ────────
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

  return turnResult;
}
