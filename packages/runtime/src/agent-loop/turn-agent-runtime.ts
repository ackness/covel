import { settleAgentLoop } from "./settle-agent-loop.js";
import { createWorldModelView } from "../function-runtime/world-model-view.js";
import { reportRuntimeStarted } from "../trace/runtime-telemetry.js";
import { getTurnExecutionSignal } from "../turn-executor/turn-control.js";
import type {
  RuntimeManifest,
  RuntimeResult,
  TurnInput,
  RuntimeActivation,
  ExecutionContext,
  InputSlot,
} from "@covel/shared";
import { attachRuntimeJournal } from "../execution-journal.js";
import { DEFAULT_LOCALE, promptSegmentV1 } from "@covel/shared";
import type { LoadedRuntime } from "@covel/shared/plugin-runtime";
import { buildContext, selectPromptSegments } from "@covel/context";
import type { SessionContextSnapshot } from "@covel/context";
import type { LLMMessage } from "@covel/shared";
import type { HookPipeline } from "../hooks/pipeline.js";
import { resolveUserSettings } from "../turn-executor/turn-executor-helpers.js";
import {
  runPostContextAssemblyHook,
  type IncludedPromptSegment,
} from "../hooks/wire-helpers.js";
import { freezeInputSlots } from "./runtime-input-slots.js";
import { applyHistoryWindow, filterRuntimeHistory } from "./message-filter.js";
import { finalizeRuntimeResult } from "../turn-executor/runtime-finalization.js";
import type { TurnExecutorDeps } from "../turn-executor/turn-executor-types.js";
import { runAgentToolLoop } from "./turn-agent-tool-loop.js";
import { withSubagentDelegate } from "./subagent-delegate.js";
import {
  prepareAgentToolSurface,
  withAgentToolSurface,
} from "./agent-tool-surface.js";
import { MAX_PICTURE_ATTACHMENTS } from "./picture-attachments.js";
import { createStorySegmentStream } from "./story-stream.js";
import { attachReadDependencies } from "../read-dependencies.js";
import {
  createPluginDataVisibility,
  type PluginDataVisibility,
  type UpstreamPluginDataWrite,
} from "../function-runtime/upstream-plugin-data.js";

export interface AgentCompactionRefresh {
  readonly compacted: boolean;
  readonly messageHistory: readonly import("@covel/store").TurnMessageRecord[];
  readonly sessionSummaries: readonly import("@covel/store").SessionSummaryRecord[];
}

export interface ExecuteAgentRuntimeOptions {
  readonly upstreamProposals?: readonly import("@covel/shared").Proposal[];
  /** Writes of completed upstream runtimes of this plugin that tool reads include. */
  readonly upstreamPluginData?: readonly UpstreamPluginDataWrite[];
  /** Upstream writes of another plugin, for the services this run's tools call. */
  readonly upstreamOf?: PluginDataVisibility["upstreamOf"];
  readonly manifest: RuntimeManifest;
  readonly input: TurnInput;
  readonly loaded: LoadedRuntime;
  readonly completedResults: ReadonlyMap<string, RuntimeResult>;
  readonly deps: TurnExecutorDeps;
  readonly maxSteps: number;
  readonly timeoutMs: number;
  readonly messageHistory: readonly import("@covel/store").TurnMessageRecord[];
  /** Story text this execution produced before this runtime (see `projectExecutionStory`). */
  readonly executionStory?: readonly import("@covel/store").TurnMessageRecord[];
  readonly sessionMeta:
    | {
        turnNumber: number;
        logicalTurn?: number;
        characters: readonly {
          id?: string;
          name: string;
          type: string;
          description?: string;
          fields?: Record<string, unknown>;
        }[];
        currentCharacterId?: string;
        lastFormValues?: Record<string, unknown>;
      }
    | undefined;
  readonly hookPipeline: HookPipeline | undefined;
  readonly sessionSummaries:
    readonly import("@covel/store").SessionSummaryRecord[] | undefined;
  /**
   * Turn-scoped compaction barrier. The first assembled shared-history agent
   * prompt supplies the real system prompt used for threshold estimation.
   * When compaction occurs, the caller returns refreshed durable history for
   * one rebuild.
   */
  readonly prepareCompactedContext?: (
    systemPromptPreview: string,
  ) => Promise<AgentCompactionRefresh>;

  readonly sessionContext: SessionContextSnapshot | undefined;
  /** Canonical activation — rendered into the reserved prompt segment. */
  readonly activation?: RuntimeActivation;
  /** Resolved input bindings — rendered into the reserved inputs prompt block. */
  readonly inputs?: Readonly<Record<string, InputSlot>>;
  /** Execution identity persisted if this agent suspends mid-turn. */
  readonly executionContext: ExecutionContext;
  /** Progress scope of a nested call, persisted if this agent suspends. */
  readonly progressScopeId?: string;
  /** Frozen cross-execution `recordAs` exports — rendered into the reserved exports block. */
  readonly exports?: Readonly<Record<string, InputSlot>>;
  readonly startTime: number;
  readonly runId: string;
}

export async function executeAgentRuntime({
  upstreamProposals = [],
  upstreamPluginData = [],
  upstreamOf,
  manifest,
  input,
  loaded,
  completedResults,
  deps,
  maxSteps,
  timeoutMs,
  messageHistory,
  executionStory = [],
  sessionMeta,
  hookPipeline,
  sessionSummaries,
  prepareCompactedContext,
  sessionContext,
  activation,
  inputs,
  executionContext,
  progressScopeId,
  exports: exportSlots,
  startTime,
  runId,
}: ExecuteAgentRuntimeOptions): Promise<RuntimeResult> {
  // ── Agent runtime: LLM pipeline ─────────────────────────────
  // Emit start AFTER guard passes (or no guard exists) — prevents
  // frontend showing an infinite spinner for guard-skipped runtimes.
  await reportRuntimeStarted(deps, input.sessionId, manifest, {
    turnId: input.turnId,
    runId,
  });

  // Every agent applies the actual target budget immediately before calling it.
  const budgetEligible =
    deps.estimator !== undefined && deps.contextBudget !== undefined;

  // Choose sync vs async build path based on whether the manifest
  // declares any `input.inject` entries of kind `plugin-data`. The async
  // path resolves those against the store; the sync path
  // handles runtime-output injects without store reads.
  // Filter message history for every agent runtime: drop OTHER plugins'
  // structured tool-output JSON while keeping player/system messages,
  // narrative-like text, and the runtime's own previous outputs. Story
  // runtimes need this so they don't mimic JSON formats; post-turn extraction
  // runtimes (character-tracker / codex / npc-graph / guide) need it so
  // other plugins' JSON doesn't accumulate in their prompt turn after turn —
  // they already get the current narrative as the last story message and
  // through their inputs, their own state via plugin-data injects, and never
  // read another plugin's output from history. Conservative: player/system
  // messages and prose from any runtime are kept — only structured-looking
  // output is dropped.
  let effectiveMessageHistory = messageHistory;
  let effectiveSessionSummaries = sessionSummaries ?? [];

  // Surface player-authored plugin settings to agent prompts as
  // `{{ userSettings.<key> }}`. Merge with manifest defaults so templates
  // can rely on declared keys being present; returns undefined when the
  // manifest declares no userSettings specs, which keeps the flag-off
  // branch byte-identical to the pre-ticket variables object.
  const agentUserSettings = resolveUserSettings(manifest, input.userSettings);

  // Segment 5 event directory injection (unified event emission layer):
  // only fetched for runtimes that opted in, so consumer-only runtimes never
  // pay for the catalog lookup.
  const eventCatalogText =
    manifest.advertiseEvents === true && deps.eventDirectory
      ? await deps.eventDirectory.catalogText(
          input.sessionId,
          input.locale ?? DEFAULT_LOCALE,
        )
      : undefined;

  // A declared history window replaces the shared session view: only the
  // newest turns are sent and compaction summaries are dropped, so this
  // runtime's prompt stays bounded instead of growing with the session.
  const historyPolicy = manifest.history;
  // This text is history from the next turn on, so the same filter applies.
  const visibleStory = filterRuntimeHistory(executionStory, manifest.name);

  let includedSegments: readonly IncludedPromptSegment[] = [];
  const assembleContext = async () => {
    const promptSegments =
      (
        await deps.extensionExecution?.run(promptSegmentV1, {
          turnId: input.turnId,
          playerMessage: input.playerMessage,
        })
      )?.flat() ?? [];
    includedSegments = selectPromptSegments(promptSegments, manifest).map(
      (segment) => ({
        pluginId: segment.providerPluginId ?? "",
        id: segment.id,
      }),
    );
    const visibleHistory = filterRuntimeHistory(
      effectiveMessageHistory,
      manifest.name,
    );
    const buildParams = {
      promptSegments,
      promptTemplate: loaded.promptTemplate,
      manifest,
      turnInput: input,
      completedResults,
      messageHistory: historyPolicy
        ? applyHistoryWindow(visibleHistory, historyPolicy)
        : visibleHistory,
      sessionMeta,
      summaries:
        historyPolicy && !historyPolicy.includeSummaries
          ? []
          : effectiveSessionSummaries,
      ...(visibleStory.length > 0 ? { executionStory: visibleStory } : {}),
      // Only the model that writes the story is shown pictures; each call
      // decides by its actual model whether they are sent.
      ...(manifest.outputKind === "story" && deps.mediaStore
        ? { pictureAttachments: MAX_PICTURE_ATTACHMENTS }
        : {}),
      // Thread the unified snapshot into context building so templates can
      // read structured session data via `world`, `session`, and `player`.
      ...(sessionContext ? { sessionContext } : {}),
      ...(agentUserSettings ? { userSettings: agentUserSettings } : {}),
      ...(eventCatalogText ? { eventCatalogText } : {}),
      ...(activation ? { activation } : {}),
      ...(inputs && Object.keys(inputs).length > 0
        ? { inputSlots: inputs }
        : {}),
      ...(exportSlots && Object.keys(exportSlots).length > 0
        ? { exportSlots }
        : {}),
    } as const;

    return buildContext({ ...buildParams, store: deps.store });
  };

  let assembled = await assembleContext();
  // Compaction exists to fit the shared history view; a bounded runtime never
  // requires compaction, so it neither waits on nor triggers the turn's barrier.
  if (prepareCompactedContext && !historyPolicy) {
    // The turn context is fixed overhead like the system prompt, which it was
    // part of; the threshold estimate counts both.
    const refreshed = await prepareCompactedContext(
      [assembled.systemPrompt, assembled.turnContext]
        .filter(Boolean)
        .join("\n\n"),
    );
    if (refreshed.compacted) {
      effectiveMessageHistory = refreshed.messageHistory;
      effectiveSessionSummaries = refreshed.sessionSummaries;
      assembled = await assembleContext();
    }
  }

  // ── PostContextAssembly hook ─────────────────────────────────
  // Turn-level, once per runtime: lets plugins rewrite the assembled system
  // prompt and/or projected history before the loop. Distinct from the
  // per-call PreLLMCall — this shapes the assembled context a single time.
  const resolvedInputSlots = freezeInputSlots(inputs ?? {});
  const shapedContext = await runPostContextAssemblyHook(
    {
      pipeline: hookPipeline,
      signal: getTurnExecutionSignal(deps.turnControl),
      sessionId: input.sessionId,
      turnId: input.turnId,
      pluginId: manifest.pluginId,
      runtimeId: manifest.name,
      eventBus: deps.eventBus,
      emitter: deps.emitter,
    },
    {
      systemPrompt: assembled.systemPrompt,
      frameworkHead: assembled.frameworkHead,
      messages: assembled.messages,
      outputKind: manifest.outputKind,
      promptTemplate: loaded.promptTemplate,
      inputSlots: resolvedInputSlots,
      characters: (sessionContext?.characters ?? sessionMeta?.characters)?.map(
        ({ id, name, type, description }) =>
          Object.freeze({ id, name, type, description }),
      ),
      currentCharacterId: (sessionContext?.sessionMeta ?? sessionMeta)
        ?.currentCharacterId,
      promptSegments: includedSegments,
    },
  );

  // Keep history intact through context hooks. The per-call budget runs after
  // PreLLMCall resolves the actual model, including any hook-selected target.
  const messages: LLMMessage[] = [
    { role: "system", content: shapedContext.systemPrompt },
    ...shapedContext.messages,
  ];

  const worldBase = deps.store
    ? await createWorldModelView(
        deps.worldModelReads ?? deps.store,
        input.sessionId,
        upstreamProposals,
        [],
        () => {},
        deps.dimensionContext,
      )
    : undefined;
  // The agent's own recorder; a guard that let it run kept none.
  const pluginDataVisibility = createPluginDataVisibility({
    pluginId: manifest.pluginId,
    runtimeId: manifest.name,
    runId,
    writes: upstreamPluginData,
    ...(upstreamOf ? { upstreamOf } : {}),
    ...(deps.pluginDataReadProbe ? { probe: deps.pluginDataReadProbe } : {}),
  });
  // A story answered in JSON streams only its segment text.
  const onDelta =
    deps.onDelta && manifest.outputKind === "story" && loaded.outputSchema
      ? createStorySegmentStream(deps.onDelta)
      : deps.onDelta;
  const streamDeps = onDelta === deps.onDelta ? deps : { ...deps, onDelta };
  // Imported services become tools for this run; the surface wraps the raw
  // executor, then `delegate` (which runs a sub-agent) wraps that.
  const toolExecutor = deps.toolExecutor
    ? withAgentToolSurface(
        deps.toolExecutor,
        await prepareAgentToolSurface({ manifest, input, deps }),
        deps.services,
      )
    : undefined;
  const loopDeps =
    deps.subagents && toolExecutor
      ? {
          ...streamDeps,
          toolExecutor: withSubagentDelegate(toolExecutor, deps.subagents, {
            caller: {
              pluginId: manifest.pluginId,
              runtimeId: manifest.name,
              depth: 0,
            },
            input,
            deps,
            executionContext,
          }),
        }
      : toolExecutor
        ? { ...streamDeps, toolExecutor }
        : streamDeps;
  const toolLoop = await runAgentToolLoop({
    worldBase,
    upstreamProposals,
    pluginDataVisibility,
    manifest,
    input,
    ...(sessionMeta?.turnNumber !== undefined
      ? { turnNumber: sessionMeta.turnNumber }
      : {}),
    ...(sessionMeta?.logicalTurn !== undefined
      ? { logicalTurn: sessionMeta.logicalTurn }
      : {}),
    loaded,
    inputSlots: resolvedInputSlots,
    promptSegments: includedSegments,
    deps: loopDeps,
    maxSteps,
    timeoutMs,
    messages,
    ...(budgetEligible
      ? { estimator: deps.estimator, contextBudget: deps.contextBudget }
      : {}),
    // The cue after this turn's story is one more user message of the
    // current turn; the budget must keep the whole turn.
    currentTurnUserMessages: assembled.currentTurnUserMessages,
    hookPipeline,
    startTime,
    runId,
    executionContext,
    ...(progressScopeId !== undefined ? { progressScopeId } : {}),
  });
  if ("status" in toolLoop) return toolLoop;

  const settled = settleAgentLoop({
    manifest,
    input,
    runId,
    startTime,
    toolLoop,
    outputSchema: loaded.outputSchema,
  });

  const result = await finalizeRuntimeResult(
    { ...deps, hookPipeline },
    manifest,
    input,
    settled.result,
    {
      lastTarget: toolLoop.lastTarget,
      deltaCount: toolLoop.streamDeltaCount,
      outputContractSchema: loaded.outputContractSchema,
      ...(settled.kind === "success" && loaded.outputSchema
        ? { agentOutputSchema: loaded.outputSchema }
        : {}),
    },
  );
  if (settled.kind === "success" && result.status === "success")
    attachReadDependencies(result, pluginDataVisibility.recorder);
  if (settled.kind === "success" && deps.store && result.output) {
    attachRuntimeJournal(
      result,
      input,
      manifest,
      result.output as Record<string, unknown>,
    );
  }
  return result;
}
