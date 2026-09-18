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
import { DEFAULT_LOCALE } from "@covel/shared";
import type { LoadedRuntime } from "@covel/shared/plugin-runtime";
import {
  buildContext,
  buildContextAsync,
  needsAsyncBuild,
} from "@covel/context";
import type {
  CoreMemoryBlockView,
  SessionContextSnapshot,
} from "@covel/context";
import type { LLMMessage } from "../llm/llm-adapter.js";
import type { HookPipeline } from "../hooks/pipeline.js";
import { resolveUserSettings } from "../turn-executor/turn-executor-helpers.js";
import { runPostContextAssemblyHook } from "../hooks/wire-helpers.js";
import { formatToolLoopFailure } from "../turn-executor/turn-output-helpers.js";
import { finalizeAgentOutput } from "./finalize-agent-output.js";
import { agentInputSlots } from "./runtime-input-slots.js";
import { filterRuntimeHistory } from "./message-filter.js";
import {
  checkSchemaProseFailure,
  checkSchemaValidation,
} from "./runtime-output-validator.js";
import { finalizeRuntimeResult } from "../turn-executor/runtime-finalization.js";
import type { TurnExecutorDeps } from "../turn-executor/turn-executor-types.js";
import { runAgentToolLoop } from "./turn-agent-tool-loop.js";
import { completionContractError } from "./runtime-completion.js";

export interface AgentCompactionRefresh {
  readonly compacted: boolean;
  readonly messageHistory: readonly import("@covel/store").TurnMessageRecord[];
  readonly sessionSummaries: readonly import("@covel/store").SessionSummaryRecord[];
}

export interface ExecuteAgentRuntimeOptions {
  readonly manifest: RuntimeManifest;
  readonly input: TurnInput;
  readonly loaded: LoadedRuntime;
  readonly completedResults: ReadonlyMap<string, RuntimeResult>;
  readonly deps: TurnExecutorDeps;
  readonly maxSteps: number;
  readonly timeoutMs: number;
  readonly messageHistory: readonly import("@covel/store").TurnMessageRecord[];
  readonly sessionMeta:
    | {
        turnNumber: number;
        characters: readonly {
          id?: string;
          name: string;
          type: string;
          description?: string;
          fields?: Record<string, unknown>;
        }[];
        lastFormValues?: Record<string, unknown>;
      }
    | undefined;
  readonly hookPipeline: HookPipeline | undefined;
  readonly sessionSummaries:
    readonly import("@covel/store").SessionSummaryRecord[] | undefined;
  /**
   * Turn-scoped compaction barrier. The first assembled agent prompt supplies
   * the real system prompt used for threshold estimation. When compaction
   * occurs, the caller returns refreshed durable history for one rebuild.
   */
  readonly prepareCompactedContext?: (
    systemPromptPreview: string,
  ) => Promise<AgentCompactionRefresh>;
  readonly workingMemory:
    readonly import("@covel/context").WorkingMemoryEntry[] | undefined;
  readonly coreMemoryBlocks: readonly CoreMemoryBlockView[] | undefined;
  readonly sessionContext: SessionContextSnapshot | undefined;
  /** Canonical activation — rendered into the reserved prompt segment. */
  readonly activation?: RuntimeActivation;
  /** Resolved input bindings — rendered into the reserved inputs prompt block. */
  readonly inputs?: Readonly<Record<string, InputSlot>>;
  /** Execution identity persisted if this agent suspends mid-turn. */
  readonly executionContext: ExecutionContext;
  /** Frozen cross-execution `recordAs` exports — rendered into the reserved exports block. */
  readonly exports?: Readonly<Record<string, InputSlot>>;
  readonly startTime: number;
  readonly runId: string;
}

export async function executeAgentRuntime({
  manifest,
  input,
  loaded,
  completedResults,
  deps,
  maxSteps,
  timeoutMs,
  messageHistory,
  sessionMeta,
  hookPipeline,
  sessionSummaries,
  prepareCompactedContext,
  workingMemory,
  coreMemoryBlocks,
  sessionContext,
  activation,
  inputs,
  executionContext,
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
  // path resolves those against the store; the sync path is unchanged
  // and handles all legacy runtime-output injects.
  // Filter message history for every agent runtime: drop OTHER plugins'
  // structured tool-output JSON while keeping player/system messages,
  // narrative-like text, and the runtime's own previous outputs. Story
  // runtimes need this so they don't mimic JSON formats; post-turn extraction
  // runtimes (character-tracker / codex / npc-graph / scene-prompts) need it so
  // other plugins' JSON doesn't accumulate in their prompt turn after turn —
  // they already get the current narrative via `<narrator-output>` and their
  // own state via plugin-data injects, and never read another plugin's output
  // from history. Conservative: player/system messages and prose from any
  // runtime are kept — only structured-looking output is dropped.
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

  const assembleContext = () => {
    const buildParams = {
      promptTemplate: loaded.promptTemplate,
      manifest,
      // Segments 9/10 (Author's Note + Post-History) read authorsNote/postHistory
      // from activeManifests. Use the locale-resolved `loaded.manifest` (parsed
      // from PLUGIN.<locale>.md) so an en session gets the localized notes, while
      // `manifest` (the canonical registry manifest) still drives inject/execution
      // semantics — avoids any PLUGIN.en.md frontmatter drift leaking into scheduling.
      activeManifests: [loaded.manifest],
      turnInput: input,
      completedResults,
      messageHistory: filterRuntimeHistory(
        effectiveMessageHistory,
        manifest.name,
      ),
      sessionMeta,
      summaries: effectiveSessionSummaries,
      workingMemory: workingMemory ?? [],
      coreMemoryBlocks: coreMemoryBlocks ?? [],
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

    return needsAsyncBuild({ manifest })
      ? buildContextAsync({ ...buildParams, store: deps.store })
      : Promise.resolve(buildContext(buildParams));
  };

  let assembled = await assembleContext();
  if (prepareCompactedContext) {
    const refreshed = await prepareCompactedContext(assembled.systemPrompt);
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
  const resolvedInputSlots = agentInputSlots(
    manifest,
    completedResults,
    inputs,
  );
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
      messages: assembled.messages,
      outputKind: manifest.outputKind,
      locale: input.locale,
      promptTemplate: loaded.promptTemplate,
      inputSlots: resolvedInputSlots,
      characters: (sessionContext?.characters ?? sessionMeta?.characters)?.map(
        ({ id, name, type, description }) =>
          Object.freeze({ id, name, type, description }),
      ),
    },
  );

  // Keep history intact through context hooks. The per-call budget runs after
  // PreLLMCall resolves the actual model, including any hook-selected target.
  const messages: LLMMessage[] = [
    { role: "system", content: shapedContext.systemPrompt },
    ...shapedContext.messages,
  ];

  const toolLoop = await runAgentToolLoop({
    manifest,
    input,
    ...(sessionMeta?.turnNumber !== undefined
      ? { turnNumber: sessionMeta.turnNumber }
      : {}),
    loaded,
    inputSlots: resolvedInputSlots,
    deps,
    maxSteps,
    timeoutMs,
    messages,
    ...(budgetEligible
      ? { estimator: deps.estimator, contextBudget: deps.contextBudget }
      : {}),
    hookPipeline,
    startTime,
    runId,
    executionContext,
  });
  if ("status" in toolLoop) return toolLoop;

  const {
    finalContent,
    finalToolOutput,
    collectedToolCalls,
    executedToolCalls,
    failedToolCalls,
    pendingProposals,
    emittedEvents,
    streamDeltaCount,
    stoppedWithResponse,
    effectiveMaxSteps,
    deadline,
  } = toolLoop;

  const finalizeFailure = (result: RuntimeResult): Promise<RuntimeResult> =>
    finalizeRuntimeResult({ ...deps, hookPipeline }, manifest, input, result, {
      lastTarget: toolLoop.lastTarget,
      deltaCount: streamDeltaCount,
    });

  if (!stoppedWithResponse && !finalContent) {
    return finalizeFailure({
      pluginId: manifest.pluginId,
      runtimeId: manifest.name,
      runId,
      turnId: input.turnId,
      status: "failed",
      output: null,
      toolCalls: collectedToolCalls,
      durationMs: Date.now() - startTime,
      error: formatToolLoopFailure({
        runtimeId: manifest.name,
        reason: Date.now() >= deadline ? "timeout" : "max_steps",
        maxSteps: effectiveMaxSteps,
        failedToolCalls,
      }),
      timestamp: new Date().toISOString(),
    });
  }

  // `requireToolUse` unmet: the runtime declared that calling a tool IS its
  // job, and it never did — the loop already nudged it once and released so a
  // stubborn model cannot wedge the turn. Reporting success here would hand the
  // player an empty panel behind a green check, with nothing in the trace to
  // explain it, so fail with a diagnostic instead. Whatever prose the model
  // produced is not this runtime's contract and is deliberately dropped.
  const completionError = completionContractError(manifest, toolLoop);
  if (completionError) {
    return finalizeFailure({
      pluginId: manifest.pluginId,
      runtimeId: manifest.name,
      runId,
      turnId: input.turnId,
      status: "failed",
      output: null,
      toolCalls: collectedToolCalls,
      durationMs: Date.now() - startTime,
      error: completionError,
      timestamp: new Date().toISOString(),
    });
  }

  // Build the runtime output from final content + tool results. This shares the
  // exact transform with the resume path (finalizeAgentOutput). The schema gate
  // below runs the two schema-declared-runtime checks — prose-instead-of-JSON
  // and schema validation — that the resume path intentionally skips. A
  // schema-declared runtime that returns unparseable prose or a non-conforming
  // envelope surfaces a real `failed` result with a diagnostic instead of
  // silently falling back to narrativeOutput.
  const finalized = finalizeAgentOutput({
    manifest,
    finalContent,
    ...(finalToolOutput ? { preferredOutput: finalToolOutput } : {}),
    executedToolCalls,
    failedToolCalls,
    pendingProposals,
    emittedEvents,
    dedupeInteractions: true,
    schemaGate:
      loaded.outputSchema && manifest.outputKind !== "story"
        ? ({ output: built, parsedAsJson, finalContent: content }) => {
            const ctx = {
              manifest,
              input,
              runId,
              startTime,
              collectedToolCalls,
              outputSchema: loaded.outputSchema!,
            };
            if (content !== null) {
              const proseFailure = checkSchemaProseFailure(
                ctx,
                content,
                parsedAsJson,
              );
              if (proseFailure) {
                // Emission happens in finalizeFailure (the short-circuit
                // result routes through it) — emitting here too would
                // double-fire.
                return proseFailure;
              }
            }
            const schemaFailure = checkSchemaValidation(ctx, built);
            if (schemaFailure) {
              return schemaFailure;
            }
            return undefined;
          }
        : undefined,
  });

  if (finalized.kind === "tool-failed" || finalized.kind === "invalid-output") {
    return finalizeFailure({
      pluginId: manifest.pluginId,
      runtimeId: manifest.name,
      runId,
      turnId: input.turnId,
      status: "failed",
      output: null,
      toolCalls: collectedToolCalls,
      durationMs: Date.now() - startTime,
      error:
        finalized.kind === "invalid-output"
          ? finalized.error
          : formatToolLoopFailure({
              runtimeId: manifest.name,
              reason: "tool_failed_without_output",
              failedToolCalls,
            }),
      timestamp: new Date().toISOString(),
    });
  }
  if (finalized.kind === "short-circuit") {
    return finalizeFailure(finalized.result);
  }
  const output = finalized.output;

  const rawResult: RuntimeResult = {
    pluginId: manifest.pluginId,
    runtimeId: manifest.name,
    runId,
    turnId: input.turnId,
    status: "success",
    output,
    toolCalls: collectedToolCalls,
    durationMs: Date.now() - startTime,
    timestamp: new Date().toISOString(),
  };

  const result = await finalizeRuntimeResult(
    { ...deps, hookPipeline },
    manifest,
    input,
    rawResult,
    { lastTarget: toolLoop.lastTarget, deltaCount: streamDeltaCount },
  );
  if (deps.store && result.output) {
    attachRuntimeJournal(
      result,
      input,
      manifest,
      result.output as Record<string, unknown>,
    );
  }
  return result;
}
