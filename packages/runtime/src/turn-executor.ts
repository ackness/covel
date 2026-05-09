/**
 * TurnExecutor — orchestrates a complete turn execution.
 *
 * Pipeline: Input → Trigger Filter → Schedule → [For each group: Context → LLM → Validate] → Result
 *
 * Note: RuntimeOutput is intentionally Record<string, unknown> — plugins produce
 * arbitrary output shapes. The session kernel normalizes them into typed Proposals.
 */

import type {
  Proposal,
  RuntimeManifest,
  RuntimeResult,
  ToolCallRecord,
  TurnInput,
  TurnResult,
} from "@covel/shared";
import { isEnvEnabled } from "@covel/shared";
import type { TurnMessageRecord, SuspensionRecord } from "@covel/store";
import {
  isSuspendSentinel,
  isRuntimeDoneSentinel,
  validateOutput,
  withPendingProposals,
} from "@covel/tools";
import { shouldTrigger } from "./trigger.js";
import {
  isMainLoopPriority,
  isPreGamePriority,
  scheduleByPriority,
} from "./scheduler.js";
import { scheduleByDag } from "./dag-scheduler.js";
import {
  applyBranchReplyAcceptedCandidates,
  buildContext,
  buildContextAsync,
  buildSessionContextSnapshot,
  needsAsyncBuild,
} from "@covel/context";
import type { SessionContextSnapshot } from "@covel/context";
import { executeParallel } from "./parallel-executor.js";
import type { TriggerContext, ScheduledGroup } from "./types.js";
import type { LLMMessage } from "./llm-adapter.js";
import type { HookPipeline } from "./hooks/pipeline.js";
import {
  buildToolDefinitions,
  makeFailedResult,
  resolveUserSettings,
} from "./turn-executor-helpers.js";
import {
  createPluginDataWriter,
  createPluginLogger,
  createFunctionStoreView,
} from "./plugin-handler-helpers.js";
import { createRuntimeMediaContext } from "./runtime-media-context.js";
import {
  buildRetryPolicy,
  callLLMWithRetry,
  streamLLMWithRetry,
  detectToolLoop,
  perturbMessages,
  LLMRetryError,
  type RetryInfo,
} from "./llm-retry.js";
import {
  buildLlmCallingPayload,
  buildLlmRespondedErrorPayload,
  buildLlmRespondedSuccessPayload,
} from "./llm-trace-payload.js";
import {
  runTurnStartHook,
  runTurnStopHook,
  runPreRuntimeHook,
  runPostRuntimeHook,
  runPreToolUseHook,
  runPostToolUseHook,
} from "./hooks/wire-helpers.js";
import {
  buildRuntimeOutputFromResult,
  createAssetProgressEmitter,
  emitSubEvent,
  isTrustedPluginSource,
} from "./turn-runtime-helpers.js";
import {
  __testOnly_parseFinalOutputEnvelope,
  extractRequiredFields,
  extractToolFailureMessage,
  findLastStructuredToolOutput,
  findPresentableToolOutput,
  formatToolLoopFailure,
  isRecord,
  isRequiredUpstreamSatisfied,
  looksLikeStructuredRuntimeOutput,
  parseFinalOutputEnvelope,
  sanitizeStoryNarrativeText,
  shouldRetryMalformedToolArguments,
  shouldSuppressToolLoopNarrative,
  type ExecutedToolCallState,
  type FailedToolCallState,
} from "./turn-output-helpers.js";
import { executeOneRuntime } from "./turn-runtime-execution.js";
import {
  MaxRecursionExceeded,
  type RecursiveTurnInput,
  type TurnExecutorDeps,
  type TurnExecutorOptions,
} from "./turn-executor-types.js";

export {
  __testOnly_parseFinalOutputEnvelope,
  looksLikeStructuredRuntimeOutput,
} from "./turn-output-helpers.js";
export {
  MaxRecursionExceeded,
  type TurnExecutorDeps,
  type TurnExecutorOptions,
} from "./turn-executor-types.js";
export {
  resumeSuspendedRuntime,
  type ResumeSuspendedRuntimeOptions,
} from "./turn-resume.js";

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

  // 0a. Await any in-flight memory update from the previous turn before we
  // load coreMemoryBlocks. Without this, a player who submits two turns
  // back-to-back will see the second turn's prompt assembled against the
  // stale blocks from *before* last turn's update finished writing.
  // Fire-and-forget semantics are preserved for callers that don't care —
  // only THIS turn-start blocks on the previous write.
  if (deps.memorySystem?.updater.awaitPending) {
    await deps.memorySystem.updater.awaitPending(input.sessionId);
  }

  // 0. Load message history from store (append-only conversation history)
  let messageHistory: readonly TurnMessageRecord[] = [];
  if (deps.store) {
    messageHistory = await deps.store.listTurnMessages(input.sessionId);
  }

  // turnNumber = number of player messages BEFORE the current one.
  // Must be computed from the pre-append history to preserve 0-based semantics
  // that interval-based triggers depend on (e.g. interval:2 fires at 0,2,4…).
  const turnNumber = messageHistory.filter(
    (m) => m.sourceType === "player",
  ).length;

  // Save player message to the append-only history.
  // Skip for manual-trigger turns — plugin-rpc invocations are not player
  // chat messages and must not pollute history or bump turnsSinceLastTrigger.
  if (deps.store && shouldAppendPlayerMessage) {
    await deps.store.appendTurnMessage({
      id: crypto.randomUUID(),
      sessionId: input.sessionId,
      turnId: input.turnId,
      sourceType: "player",
      role: "user",
      content: input.playerMessage,
      order: 0,
      createdAt: new Date().toISOString(),
    });
    // Reload so messageHistory includes the current player message.
    // This ensures turnsSinceLastTrigger counts the current turn correctly —
    // without this, cooldownTurns checks always see 0 player messages after
    // the last runtime message, blocking plugins like guide on every
    // subsequent turn.
    messageHistory = await deps.store.listTurnMessages(input.sessionId);
  }

  // 0b. Compaction (S2-T2): run before buildContext so summaries are stored
  //     before the turn's context assembly reads them.
  //     Only runs when COVEL_COMPACTOR_V1=1 AND a compactor is injected.
  //     Skipped for manual triggers — they don't add player messages, so
  //     there's nothing new to compact.
  if (
    isEnvEnabled("COVEL_COMPACTOR_V1") &&
    deps.compactor &&
    deps.store &&
    shouldAppendPlayerMessage
  ) {
    // Reload messages after appending the player message so the compactor
    // sees the full updated history (including the just-appended player msg).
    const freshMessages = await deps.store.listTurnMessages(input.sessionId);
    await deps.compactor.run(input.sessionId, "", freshMessages);
    // Reload the history for subsequent processing (trigger counts, etc.)
    messageHistory = await deps.store.listTurnMessages(input.sessionId);
  }

  // 1. Trigger filter — determine which runtimes should run this turn
  //    Each runtime gets its own triggerContext with accurate triggerCount from store.
  // Build a map of runtimeId → number of times it has been triggered (from message history)
  // We use TurnMessages with sourceType='runtime' as the trigger count source.
  // Key by sourceRuntimeId (e.g. "world-init/schema-gen") to match rt.name used in lookup,
  // since sourcePluginId stores the plugin package ID (e.g. "world-init") which differs for
  // multi-runtime plugins.
  const runtimeTriggerCounts = new Map<string, number>();
  for (const msg of messageHistory) {
    if (msg.sourceType === "runtime" && msg.sourceRuntimeId) {
      runtimeTriggerCounts.set(
        msg.sourceRuntimeId,
        (runtimeTriggerCounts.get(msg.sourceRuntimeId) ?? 0) + 1,
      );
    }
  }

  // Load session metadata for context injection (turnNumber, characters, lastFormValues, status, preGameCompleted).
  let sessionStatus: "active" | "paused" | "ended" = "active";
  let preGameCompleted: readonly string[] = [];
  let sessionCharacters: {
    name: string;
    type: string;
    description?: string;
    fields?: Record<string, unknown>;
  }[] = [];
  let lastFormValues: Record<string, unknown> | undefined;
  if (deps.store) {
    const session = await deps.store.getSession(input.sessionId);
    if (session) {
      sessionStatus = session.status;
      preGameCompleted = session.preGameCompleted ?? [];
    }
    const charRecords = await deps.store.listCharacters(input.sessionId);
    sessionCharacters = charRecords.map((c) => ({
      name: c.name,
      type: c.type,
      description: c.description,
      fields: c.fields as Record<string, unknown>,
    }));
    // Most recent player submission — latest row in player_inputs for this session.
    // Plugins read this via `{{ player.lastFormValues }}` to process form submissions.
    try {
      const inputs = await deps.store.listPlayerInputs(input.sessionId);
      if (inputs.length > 0) {
        const latest = inputs[inputs.length - 1];
        if (latest?.values && typeof latest.values === "object") {
          lastFormValues = latest.values as Record<string, unknown>;
        }
      }
    } catch {
      // Non-critical: player inputs may not exist yet
    }
  }
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
  let sessionMeta = {
    turnNumber,
    characters: sessionCharacters,
    lastFormValues,
    preGameCompleted,
  };
  const promptHistory = messageHistory.filter(
    (msg) => !(msg.turnId === input.turnId && msg.sourceType === "player"),
  );
  let projectedPromptHistory: readonly TurnMessageRecord[] = promptHistory;
  if (deps.store) {
    try {
      const branchReplyTurns = await deps.store.listPluginData(
        input.sessionId,
        "branch-reply",
        "turns",
      );
      projectedPromptHistory = applyBranchReplyAcceptedCandidates(
        promptHistory,
        branchReplyTurns,
      );
    } catch {
      projectedPromptHistory = promptHistory;
    }
  }
  const preGameRuntimes = activeRuntimes.filter(
    (rt) => rt.priority !== undefined && rt.priority <= 99,
  );
  const isPreGamePending = preGameRuntimes.some(
    (rt) => !preGameCompleted.includes(rt.name),
  );

  // Manual trigger short-circuit: plugin-rpc targeted one specific runtime,
  // so bypass the per-runtime shouldTrigger check and only run that runtime
  // plus any event-chain it produces (handled after the groups loop).
  const manualTarget = input.manualTrigger
    ? activeRuntimes.find((rt) => rt.name === input.manualTrigger!.runtimeId)
    : undefined;
  if (input.manualTrigger && !manualTarget) {
    return {
      turnId: input.turnId,
      sessionId: input.sessionId,
      runtimeResults: [],
      durationMs: Date.now() - startTime,
      timestamp: new Date().toISOString(),
      abortReason: `manual-trigger: runtime not found or inactive: ${input.manualTrigger.runtimeId}`,
    };
  }

  const triggered = manualTarget
    ? [manualTarget]
    : activeRuntimes.filter((rt) => {
        // Compute turnsSinceLastTrigger: count player messages after this runtime's last message
        let lastRuntimeMsgIdx = -1;
        for (let i = messageHistory.length - 1; i >= 0; i--) {
          const m = messageHistory[i];
          if (m.sourceType === "runtime" && m.sourceRuntimeId === rt.name) {
            lastRuntimeMsgIdx = i;
            break;
          }
        }
        const turnsSinceLastTrigger =
          lastRuntimeMsgIdx >= 0
            ? messageHistory
                .slice(lastRuntimeMsgIdx)
                .filter((m) => m.sourceType === "player").length
            : 999;

        const triggerContext: TriggerContext = {
          sessionId: input.sessionId,
          turnNumber,
          triggerCount: runtimeTriggerCounts.get(rt.name) ?? 0,
          turnsSinceLastTrigger,
          pendingEventTopics: [],
          hasUpstreamFailure: false,
          isManualTrigger: false,
          preGameCompleted,
        };
        return shouldTrigger(rt, triggerContext);
      });

  // 2. Schedule runtimes.
  //
  // Pre-Game band uses strict priority ordering while setup runtimes are
  // pending: pregame plugins
  // have implicit write-ordering (pregame → world-init/schema-gen → player-init,
  // audit P0-2) that is NOT captured in manifest inject declarations, so
  // falling back to priority is the right semantic. player-init's prompt
  // reads `{{ config.worldSchema }}` populated by schema-gen via
  // loadSessionConfig — schema-gen MUST land first in the same setup pass.
  //
  // Main-loop band uses the DAG scheduler after setup completes: it parallelises any
  // runtimes whose declared upstreams (input.inject + upstreamRequired) have
  // already completed. Independent branches (narrator's four downstream
  // plugins — guide/codex/extractor/char-tracker) run concurrently instead
  // of being serialised by numeric priority. Falls back to priority ordering
  // only if a cycle is detected (plugin authoring mistake).
  //
  // See packages/runtime/src/dag-scheduler.ts for the algorithm.
  let groups: readonly ScheduledGroup[];
  if (manualTarget) {
    // Manual trigger: one-runtime group. Event-chain resolution happens in the
    // post-group loop below, so any event-triggered downstreams fire in
    // priority order without going through the DAG scheduler.
    groups = [
      {
        priority: manualTarget.priority ?? 500,
        runtimes: [manualTarget],
      },
    ];
  } else if (isPreGamePending) {
    const preGameTriggered = triggered.filter((rt) =>
      isPreGamePriority(rt.priority),
    );
    groups = scheduleByPriority(preGameTriggered, 0);
  } else {
    const mainLoop = triggered.filter((rt) => isMainLoopPriority(rt.priority));
    const dag = scheduleByDag(mainLoop);
    if (dag.error) {
      console.warn(
        `[turn-executor] DAG scheduler: ${dag.error}; falling back to priority ordering`,
      );
      groups = scheduleByPriority(triggered, turnNumber);
    } else {
      groups = dag.groups;
    }
  }

  // Load session summaries for compaction substitution in buildContext (S2-T2)
  let sessionSummaries: import("@covel/store").SessionSummaryRecord[] = [];
  if (isEnvEnabled("COVEL_COMPACTOR_V1") && deps.store) {
    sessionSummaries = [
      ...(await deps.store.listSessionSummaries(input.sessionId)),
    ];
  }

  // Load working memory for prompt injection (S3-T3, B1 fix).
  // The store may not implement listWorkingMemory on older backends, so we
  // probe for the method before calling. The downstream context-builder gates
  // actual rendering on COVEL_WORKING_MEMORY_V1=1, so loading here is cheap
  // and idempotent — when the flag is off, the loaded entries are simply not
  // rendered into the system prompt.
  let workingMemory: readonly import("@covel/context").WorkingMemoryEntry[] =
    [];
  if (deps.store && typeof deps.store.listWorkingMemory === "function") {
    try {
      const records = await deps.store.listWorkingMemory(input.sessionId);
      workingMemory = records.map((r) => ({
        scope: r.scope,
        key: r.key,
        value: r.value,
      }));
    } catch {
      // Non-critical: working memory load failures must not abort the turn.
      workingMemory = [];
    }
  }

  // Load core memory blocks (Letta-style three-tier memory).
  // When COVEL_MEMORY_V1=1 and a memory system is injected, load the blocks
  // so they can be injected into every runtime's prompt as [Core Memory].
  let coreMemoryBlocks: readonly {
    label: string;
    content: string;
    updatedAt: string;
  }[] = [];
  if (isEnvEnabled("COVEL_MEMORY_V1") && deps.memorySystem) {
    try {
      await deps.memorySystem.manager.initializeDefaults(input.sessionId);
      coreMemoryBlocks = await deps.memorySystem.manager.loadBlocks(
        input.sessionId,
      );
    } catch {
      // Non-critical: memory load failures must not abort the turn.
      coreMemoryBlocks = [];
    }
  }

  // Sprint 1-D: Unified SessionContextSnapshot loader (feature-flagged).
  //
  // When COVEL_SESSION_CONTEXT=1, collapse all the scattered reads above into a
  // single `buildSessionContextSnapshot` call. The snapshot carries the same
  // data (session meta, characters, world bundle, lore entries, working memory,
  // core blocks, summaries) plus a pre-built `legacyConfigView` that is
  // byte-identical to `loadSessionConfig()` — so downstream prompt assembly can
  // read from `snapshot.legacyConfigView` transparently.
  //
  // The flag-off path below preserves the original scattered-load behaviour
  // (unchanged from pre-Sprint 1). We accept a minor DB read duplication on
  // flag-on turns for Sprint 1: Sprint 2 (Lorebook) removes the duplicates by
  // deleting the legacy reads once all consumers migrate to the snapshot.
  let sessionContext: SessionContextSnapshot | undefined;
  const refreshSessionContext = async (): Promise<void> => {
    if (!isEnvEnabled("COVEL_SESSION_CONTEXT") || !deps.store) return;
    try {
      const sessionRecord = await deps.store.getSession(input.sessionId);
      sessionContext = await buildSessionContextSnapshot(
        deps.store,
        input.sessionId,
        {
          locale: input.locale ?? "zh-CN",
          turnNumber,
          worldId: sessionRecord?.worldId ?? undefined,
          worldDataPluginId: deps.worldDataPluginId,
          coreMemoryBlocks,
          summaries: sessionSummaries,
          playerMessage: input.playerMessage,
        },
      );
    } catch (err) {
      // Non-critical: snapshot build failures must not abort the turn.
      // Legacy scattered reads above still cover every downstream consumer.
      console.warn(
        "[turn-executor] SessionContextSnapshot build failed, falling back to legacy reads:",
        err instanceof Error ? err.message : String(err),
      );
    }
  };
  await refreshSessionContext();

  // 3. Execute each group
  const completedResults = new Map<string, RuntimeResult>();
  // Collect emitted events as a topic → payload map. First emission wins if
  // multiple runtimes publish the same topic in a single depth — keeps the
  // chain deterministic and avoids one runtime silently overriding another.
  const collectEventsFrom = (
    result: RuntimeResult,
    sink: Map<string, Record<string, unknown>>,
  ): void => {
    const output = result.output as Record<string, unknown> | null | undefined;
    const events = output?.events as Array<Record<string, unknown>> | undefined;
    if (!events) return;
    for (const evt of events) {
      const topic = evt?.topic;
      if (typeof topic !== "string" || topic.length === 0) continue;
      if (sink.has(topic)) continue;
      const data = (evt?.data as Record<string, unknown> | undefined) ?? {};
      sink.set(topic, data);
    }
  };

  const markPreGameCompletion = async (): Promise<boolean> => {
    if (!isPreGamePending || !deps.store || input.manualTrigger) {
      return !isPreGamePending;
    }
    const newlyDone: string[] = [];
    for (const [name, result] of completedResults) {
      if (preGameCompleted.includes(name)) continue;
      const output = result.output as Record<string, unknown> | undefined;
      const preGameDone = output?.preGameDone === true;
      const guardSkipped = result.status === "skipped" && output?.skip === true;
      if (preGameDone || guardSkipped) {
        newlyDone.push(name);
      }
    }

    // Mark runtimes that hit maxTriggerCount as done — they were never
    // scheduled but shouldn't hold up Pre-Game forever.
    for (const rt of activeRuntimes) {
      if (rt.priority === undefined || rt.priority > 99) continue;
      if (preGameCompleted.includes(rt.name)) continue;
      if (newlyDone.includes(rt.name)) continue;
      const max = rt.trigger?.maxTriggerCount;
      if (
        max !== undefined &&
        (runtimeTriggerCounts.get(rt.name) ?? 0) >= max
      ) {
        newlyDone.push(rt.name);
      }
    }

    const updated =
      newlyDone.length > 0
        ? [...preGameCompleted, ...newlyDone]
        : preGameCompleted;
    const allDone = preGameRuntimes.every((rt) => updated.includes(rt.name));

    if (newlyDone.length > 0) {
      preGameCompleted = updated;
      await deps.store.updateSession(input.sessionId, {
        preGameCompleted: updated,
        ...(allDone ? { turnCount: 1 } : {}),
        updatedAt: new Date().toISOString(),
      });
      const refreshedCharacters = await deps.store.listCharacters(
        input.sessionId,
      );
      sessionMeta = {
        ...sessionMeta,
        preGameCompleted,
        characters: refreshedCharacters.map((c) => ({
          name: c.name,
          type: c.type,
          description: c.description,
          fields: c.fields as Record<string, unknown>,
        })),
      };
      await refreshSessionContext();
    }

    return allDone;
  };

  // Manual-trigger turns can carry an optional `triggerEvent` payload — used
  // by the plugin-rpc background follower path so a deferred follower runtime
  // receives the same `ctx.triggerEvent` shape it would have seen during the
  // synchronous event-chain fan-out. Undefined for everyone else.
  const manualTriggerEventPayload = manualTarget
    ? input.manualTrigger?.triggerEvent
    : undefined;

  for (const group of groups) {
    const results = await executeParallel(group.runtimes, async (manifest) => {
      const triggerEventForRuntime =
        manualTarget &&
        manualTriggerEventPayload &&
        manifest.name === manualTarget.name
          ? manualTriggerEventPayload
          : undefined;
      return executeOneRuntime(
        manifest,
        input,
        activeRuntimes,
        completedResults,
        deps,
        maxSteps,
        defaultTimeoutMs,
        projectedPromptHistory,
        sessionMeta,
        deps.hookPipeline,
        sessionSummaries,
        workingMemory,
        coreMemoryBlocks,
        sessionContext,
        triggerEventForRuntime,
        options,
        executeTurn,
        recursionDepth,
      );
    });

    // Merge results
    for (const [name, result] of results) {
      completedResults.set(name, result);
    }
  }

  const completedPreGameThisTurn = isPreGamePending
    ? await markPreGameCompletion()
    : false;
  if (completedPreGameThisTurn && !manualTarget) {
    const mainLoop = triggered.filter(
      (rt) => isMainLoopPriority(rt.priority) && !completedResults.has(rt.name),
    );
    const dag = scheduleByDag(mainLoop);
    const followupGroups = dag.error
      ? scheduleByPriority(mainLoop, turnNumber)
      : dag.groups;
    for (const group of followupGroups) {
      const results = await executeParallel(
        group.runtimes,
        async (manifest) => {
          return executeOneRuntime(
            manifest,
            input,
            activeRuntimes,
            completedResults,
            deps,
            maxSteps,
            defaultTimeoutMs,
            projectedPromptHistory,
            sessionMeta,
            deps.hookPipeline,
            sessionSummaries,
            workingMemory,
            coreMemoryBlocks,
            sessionContext,
            undefined,
            options,
            executeTurn,
            recursionDepth,
          );
        },
      );
      for (const [name, result] of results) {
        completedResults.set(name, result);
      }
    }
  }

  // 3b. Event-chain resolution.
  //
  // Any runtime may emit `output.events: [{ topic, data }]`; those topics are
  // collected here and used to schedule *unfinished* runtimes whose
  // `trigger.type === 'event'` and `trigger.topic` matches. The matched event
  // (topic + data) is forwarded to the downstream handler via
  // `ctx.triggerEvent`, so a function runtime can read the payload directly
  // without a separate store round-trip. This powers:
  //
  //   a. Manual-trigger chains — `plugin-rpc` runs a target runtime, and any
  //      event-triggered followers (e.g. image generator listening on
  //      `image.prompt.ready`) fire inside the same turn.
  //   b. Mid-turn event fan-out — a regular auto-triggered runtime can wake
  //      up an event-subscriber in the same turn (previously impossible
  //      because pendingEventTopics was always empty).
  //
  // Depth-bounded loop (MAX_EVENT_CHAIN_DEPTH) protects against plugins that
  // emit events in a cycle. Priority ordering inside each depth keeps
  // behaviour deterministic.
  const MAX_EVENT_CHAIN_DEPTH = 8;
  const emittedEvents = new Map<string, Record<string, unknown>>();
  for (const [, result] of completedResults) {
    collectEventsFrom(result, emittedEvents);
  }

  // Audit F1: followers declaring `execution: 'background'` are pulled out
  // of the sync chain and returned to the caller so it can schedule them
  // as independent `_jobs`. The sync response thus completes as soon as
  // the sync-mode runtimes finish; the caller (typically plugin-rpc) runs
  // the background followers off-cycle and the frontend picks up progress
  // via `plugin-data.changed` SSE on `_jobs/<jobId>`.
  const deferredFollowers: {
    runtimeId: string;
    pluginId: string;
    triggerEvent: { topic: string; data: Readonly<Record<string, unknown>> };
  }[] = [];

  let chainDepth = 0;
  while (emittedEvents.size > 0 && chainDepth < MAX_EVENT_CHAIN_DEPTH) {
    chainDepth += 1;
    const nextBatch = activeRuntimes.filter((rt) => {
      if (completedResults.has(rt.name)) return false;
      if (rt.trigger?.type !== "event") return false;
      return (
        rt.trigger.topic !== undefined && emittedEvents.has(rt.trigger.topic)
      );
    });
    if (nextBatch.length === 0) break;

    const ordered = [...nextBatch].sort(
      (a, b) => (a.priority ?? 500) - (b.priority ?? 500),
    );

    // Snapshot the event map *before* executing this depth — new events
    // produced by this batch must only wake the next depth, not the current.
    const currentDepthEvents = new Map(emittedEvents);
    const newEvents = new Map<string, Record<string, unknown>>();

    // Split this depth into sync-executed runtimes and deferred
    // (background) ones. Deferred runtimes don't block the turn, don't
    // contribute to completedResults, and don't wake downstream event
    // followers in THIS turn — the caller owns their fan-out.
    const syncBatch: RuntimeManifest[] = [];
    for (const manifest of ordered) {
      const topic = manifest.trigger?.topic;
      const matchedEvent =
        topic !== undefined ? currentDepthEvents.get(topic) : undefined;
      if (
        manifest.execution === "background" &&
        topic !== undefined &&
        matchedEvent !== undefined
      ) {
        deferredFollowers.push({
          runtimeId: manifest.name,
          pluginId: manifest.pluginId,
          triggerEvent: { topic, data: matchedEvent },
        });
        continue;
      }
      syncBatch.push(manifest);
    }

    if (syncBatch.length === 0) break;

    const results = await executeParallel(syncBatch, async (manifest) => {
      const topic = manifest.trigger?.topic;
      const matchedEvent =
        topic !== undefined ? currentDepthEvents.get(topic) : undefined;
      const triggerEvent =
        topic !== undefined && matchedEvent !== undefined
          ? { topic, data: matchedEvent }
          : undefined;
      return executeOneRuntime(
        manifest,
        input,
        activeRuntimes,
        completedResults,
        deps,
        maxSteps,
        defaultTimeoutMs,
        projectedPromptHistory,
        sessionMeta,
        deps.hookPipeline,
        sessionSummaries,
        workingMemory,
        coreMemoryBlocks,
        sessionContext,
        triggerEvent,
        options,
        executeTurn,
        recursionDepth,
      );
    });
    for (const [name, result] of results) {
      completedResults.set(name, result);
      collectEventsFrom(result, newEvents);
    }
    // Reset event window to just newly-produced events so stale topics from
    // earlier depths don't keep re-matching the same runtimes.
    emittedEvents.clear();
    for (const [topic, data] of newEvents) emittedEvents.set(topic, data);
  }

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
  await markPreGameCompletion();

  // Collect pending inputs from completed RuntimeResults (avoids redundant DB reload)
  const pendingInputs: import("@covel/shared").PendingInputInfo[] = [];
  for (const [, result] of completedResults) {
    if (!result.output) continue;
    const out = result.output as Record<string, unknown>;
    const interactions = out.interactions as
      | Array<Record<string, unknown>>
      | undefined;
    const form = out.form as Record<string, unknown> | undefined;
    const narrativeFallback =
      typeof out.narrativeTemplate === "string"
        ? out.narrativeTemplate
        : typeof out.narrativeOutput === "string"
          ? out.narrativeOutput
          : "";

    if (interactions && interactions.length > 0) {
      for (const interaction of interactions) {
        pendingInputs.push({
          pluginId: result.pluginId,
          runtimeId: result.runtimeId,
          interaction:
            interaction as unknown as import("@covel/shared").InteractionPayload,
          form:
            interaction.type === "form"
              ? (interaction as Record<string, unknown>)
              : undefined,
          narrativeTemplate:
            (interaction.narrativeTemplate as string) ?? narrativeFallback,
        });
      }
    } else if (form?.formId) {
      // Legacy format: single form object
      pendingInputs.push({
        pluginId: result.pluginId,
        runtimeId: result.runtimeId,
        interaction: {
          type: "form",
          interactionId: (form.formId ?? "") as string,
          ...(form as object),
        } as import("@covel/shared").InteractionPayload,
        form,
        narrativeTemplate: narrativeFallback,
      });
    }
  }

  const turnResult: TurnResult = {
    turnId: input.turnId,
    sessionId: input.sessionId,
    runtimeResults: [...completedResults.values()],
    pendingInputs: pendingInputs.length > 0 ? pendingInputs : undefined,
    durationMs: Date.now() - startTime,
    timestamp: new Date().toISOString(),
    ...(deferredFollowers.length > 0 ? { deferredFollowers } : {}),
  };

  // Persist results to store if available
  if (deps.store) {
    const now = new Date().toISOString();

    // Save each runtime result
    for (const rr of turnResult.runtimeResults) {
      await deps.store.saveRuntimeResult({
        id: rr.runId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        pluginId: rr.pluginId,
        runtimeId: rr.runtimeId,
        status: rr.status,
        output: rr.output,
        toolCalls: rr.toolCalls,
        durationMs: rr.durationMs,
        error: rr.error,
        createdAt: rr.timestamp ?? now,
      });

      // PR-1: write a normalised RuntimeOutput alongside RuntimeResult so
      // downstream consumers can read the translation-layer record without
      // knowing the runtime internals.
      try {
        await deps.store.saveRuntimeOutput(
          buildRuntimeOutputFromResult(rr, input.sessionId, turnNumber, now),
        );
      } catch (err) {
        // Translation-layer writes are best-effort in this iteration: a
        // failure here must not bring the turn down, since RuntimeResult
        // is still the authoritative record. Log and continue.
        console.warn(
          `[turn-executor] saveRuntimeOutput failed for ${rr.runtimeId}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    // Save the aggregated turn result
    await deps.store.saveTurnResult({
      id: crypto.randomUUID(),
      sessionId: input.sessionId,
      turnId: input.turnId,
      runtimeResults: turnResult.runtimeResults,
      durationMs: turnResult.durationMs,
      createdAt: turnResult.timestamp ?? now,
    });

    // ── Auto-snapshot (S4-T2) ─────────────────────────────────
    // When COVEL_SNAPSHOTS_V1=1, capture a materialized snapshot of the
    // session state at turn boundary. Failures are logged but never fail
    // the turn — snapshots are a best-effort recovery primitive, not a
    // commit invariant.
    if (isEnvEnabled("COVEL_SNAPSHOTS_V1")) {
      try {
        const { buildSnapshotPayload } =
          await import("./snapshot-payload-builder.js");
        const payload = await buildSnapshotPayload(
          deps.store,
          input.sessionId,
          input.turnId,
        );
        const snapshotId = crypto.randomUUID();
        await deps.store.saveSnapshot({
          id: snapshotId,
          sessionId: input.sessionId,
          turnId: input.turnId,
          kind: "auto",
          payload,
          createdAt: turnResult.timestamp ?? now,
        });
        // Emit SSE event so reactive UI can refresh snapshot lists.
        // Topic 'session' matches the session.forked convention; the
        // SSE forwarder picks `_subType` as the named event field.
        emitSubEvent(
          deps.eventBus,
          "session",
          "state.snapshot.created",
          input.sessionId,
          {
            turnId: input.turnId,
            snapshotId,
            kind: "auto",
          },
        );
      } catch (err) {
        // Log and continue — never block turn completion on snapshot failure.
        // eslint-disable-next-line no-console
        console.warn(
          `[turn-executor] auto snapshot failed for session ${input.sessionId} turn ${input.turnId}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  // Emit turn.completed
  emitSubEvent(deps.eventBus, "game", "turn.completed", input.sessionId, {
    turnId: input.turnId,
    sessionId: input.sessionId,
    durationMs: turnResult.durationMs,
  });

  // ── Post-turn memory update (Letta-style) ─────────────────────
  // Fire-and-forget: memory update runs asynchronously so it doesn't
  // block the turn response. Stale-by-one-turn is acceptable.
  if (
    isEnvEnabled("COVEL_MEMORY_V1") &&
    deps.memorySystem &&
    coreMemoryBlocks.length > 0
  ) {
    // Collect narrative text from all successful runtimes
    const narrativeParts: string[] = [];
    for (const rr of turnResult.runtimeResults) {
      const out = rr.output as Record<string, unknown> | null;
      const text =
        (out?.narrativeOutput as string) ?? (out?.text as string) ?? "";
      if (text.trim()) narrativeParts.push(text);
    }
    const narrativeText = narrativeParts.join("\n\n");

    // eslint-disable-next-line no-console
    console.log(
      `[memory] post-turn: ${narrativeParts.length} narrative parts, ${narrativeText.length} chars, statuses: [${turnResult.runtimeResults.map((r) => `${r.runtimeId}:${r.status}`).join(", ")}]`,
    );

    if (narrativeText.trim()) {
      const toolSummaries = turnResult.runtimeResults.flatMap((rr) =>
        rr.toolCalls.map(
          (tc) => `[${tc.toolName}] ${JSON.stringify(tc.input).slice(0, 200)}`,
        ),
      );

      deps.memorySystem.updater
        .updateAfterTurn({
          sessionId: input.sessionId,
          narrativeText,
          toolCallSummaries:
            toolSummaries.length > 0 ? toolSummaries : undefined,
          currentBlocks: coreMemoryBlocks,
          locale: input.locale,
        })
        .then((result) => {
          // eslint-disable-next-line no-console
          console.log(
            `[memory] update result: updated=${result.updated}, blocks=[${result.blocksChanged.join(",")}]${result.error ? `, error=${result.error}` : ""}`,
          );
        })
        .catch((err) => {
          // eslint-disable-next-line no-console
          console.warn(
            `[turn-executor] memory update failed for ${input.sessionId}:`,
            err instanceof Error ? err.message : String(err),
          );
        });
    } else {
      // eslint-disable-next-line no-console
      console.log(
        "[memory] post-turn: no narrative text found, skipping memory update",
      );
    }
  }

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
