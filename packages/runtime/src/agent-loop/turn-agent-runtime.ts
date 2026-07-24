import type {
  RuntimeManifest,
  RuntimeResult,
  TurnInput,
  RuntimeActivation,
  InputSlot,
} from "@covel/shared";
import { getRuntimeSpec, stageMessageOrder } from "@covel/shared";
import type { LoadedRuntime } from "@covel/plugin-loader";
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
import {
  runPreRuntimeHook,
  runPostRuntimeHook,
  runPostContextAssemblyHook,
} from "../hooks/wire-helpers.js";
import { emitSubEvent } from "../turn-executor/turn-runtime-helpers.js";
import { formatToolLoopFailure } from "../turn-executor/turn-output-helpers.js";
import { finalizeAgentOutput } from "./finalize-agent-output.js";
import { normalizeHandlerResult } from "../commit/normalize-handler-result.js";
import { filterRuntimeHistory } from "./message-filter.js";
import {
  checkSchemaProseFailure,
  checkSchemaValidation,
} from "./runtime-output-validator.js";
import {
  emitMessageCompleted,
  emitRuntimeCompleted,
  emitRuntimeFailed,
} from "../trace/runtime-telemetry.js";
import type { TurnExecutorDeps } from "../turn-executor/turn-executor-types.js";
import { runAgentToolLoop } from "./turn-agent-tool-loop.js";

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
          name: string;
          type: string;
          description?: string;
          fields?: Record<string, unknown>;
        }[];
        lastFormValues?: Record<string, unknown>;
        preGameCompleted?: readonly string[];
      }
    | undefined;
  readonly hookPipeline: HookPipeline | undefined;
  readonly sessionSummaries:
    readonly import("@covel/store").SessionSummaryRecord[] | undefined;
  readonly workingMemory:
    readonly import("@covel/context").WorkingMemoryEntry[] | undefined;
  readonly coreMemoryBlocks: readonly CoreMemoryBlockView[] | undefined;
  readonly sessionContext: SessionContextSnapshot | undefined;
  /** Canonical activation — rendered into the reserved prompt segment. */
  readonly activation?: RuntimeActivation;
  /** Resolved input bindings — rendered into the reserved inputs prompt block. */
  readonly inputs?: Readonly<Record<string, InputSlot>>;
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
  workingMemory,
  coreMemoryBlocks,
  sessionContext,
  activation,
  inputs,
  exports: exportSlots,
  startTime,
  runId,
}: ExecuteAgentRuntimeOptions): Promise<RuntimeResult> {
  // ── Agent runtime: LLM pipeline ─────────────────────────────
  // Emit start AFTER guard passes (or no guard exists) — prevents
  // frontend showing an infinite spinner for guard-skipped runtimes.
  const stage = getRuntimeSpec(manifest).stage;
  try {
    await deps.onRuntimeStart?.({
      runtimeId: manifest.name,
      pluginId: manifest.pluginId,
      ...(stage !== undefined ? { stage } : {}),
    });
  } catch {
    /* callback error must not kill runtime */
  }
  emitSubEvent(deps.eventBus, "runtime", "runtime.started", input.sessionId, {
    runtimeId: manifest.name,
    pluginId: manifest.pluginId,
    ...(stage !== undefined ? { stage } : {}),
  });

  // ── PreRuntime hook ──────────────────────────────────
  {
    const preRtResult = await runPreRuntimeHook({
      pipeline: hookPipeline,
      sessionId: input.sessionId,
      turnId: input.turnId,
      manifest,
      input,
      eventBus: deps.eventBus,
      emitter: deps.emitter,
    });
    if (preRtResult.action === "abort") {
      return {
        pluginId: manifest.pluginId,
        runtimeId: manifest.name,
        runId,
        turnId: input.turnId,
        status: "skipped",
        output: { skipped: true, reason: preRtResult.reason },
        toolCalls: [],
        durationMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    }
  }

  // Tool-declaring runtimes used to be excluded from hard budget enforcement
  // because prefix pruning could cut between an assistant message and the
  // `tool` results it requested, leaving an orphan the provider rejects.
  // `applyBudget` now drops orphaned leading tool messages, so every runtime
  // — including the tool-heavy main agents that dominate long-session token
  // spend — gets the prompt-assembly hard prune.
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
  const filteredHistory = filterRuntimeHistory(messageHistory, manifest.name);

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
          input.locale ?? "zh-CN",
        )
      : undefined;

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
    messageHistory: filteredHistory,
    sessionMeta,
    summaries: sessionSummaries ?? [],
    workingMemory: workingMemory ?? [],
    coreMemoryBlocks: coreMemoryBlocks ?? [],
    // Thread the unified snapshot into context building so templates can
    // read structured session data via `world`, `session`, and `player`.
    ...(sessionContext ? { sessionContext } : {}),
    ...(agentUserSettings ? { userSettings: agentUserSettings } : {}),
    ...(eventCatalogText ? { eventCatalogText } : {}),
    ...(activation ? { activation } : {}),
    ...(inputs && Object.keys(inputs).length > 0 ? { inputSlots: inputs } : {}),
    ...(exportSlots && Object.keys(exportSlots).length > 0
      ? { exportSlots }
      : {}),
    ...(budgetEligible
      ? { estimator: deps.estimator, contextBudget: deps.contextBudget }
      : {}),
  } as const;

  const assembled = needsAsyncBuild({ manifest })
    ? await buildContextAsync({ ...buildParams, store: deps.store })
    : buildContext(buildParams);

  // A prune means this runtime's prompt lost history to fit the slot window —
  // the single place that knows it, so record it before the hook chain can
  // rewrite the assembled context.
  if (assembled.budgetExceeded && deps.emitter) {
    await deps.emitter.emit("context.pruned", {
      runtimeId: manifest.name,
      pluginId: manifest.pluginId,
      prunedMessageCount: assembled.prunedMessageCount ?? 0,
    });
  }

  // ── PostContextAssembly hook ─────────────────────────────────
  // Turn-level, once per runtime: lets plugins rewrite the assembled system
  // prompt and/or projected history before the loop. Distinct from the
  // per-call PreLLMCall — this shapes the assembled context a single time.
  const shapedContext = await runPostContextAssemblyHook(
    {
      pipeline: hookPipeline,
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
    },
  );

  // Build LLM messages
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
    deps,
    maxSteps,
    timeoutMs,
    messages,
    hookPipeline,
    startTime,
    runId,
  });
  if ("status" in toolLoop) return toolLoop;

  const {
    finalContent,
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

  // Shared PostRuntime-hook opts for every terminal path of this runtime.
  const postRuntimeOpts = {
    pipeline: hookPipeline,
    sessionId: input.sessionId,
    turnId: input.turnId,
    pluginId: manifest.pluginId,
    runtimeId: manifest.name,
    eventBus: deps.eventBus,
    emitter: deps.emitter,
  };
  const finalizeFailure = (result: RuntimeResult): Promise<RuntimeResult> =>
    runPostRuntimeHook(postRuntimeOpts, result);

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
            const proseFailure = checkSchemaProseFailure(
              ctx,
              content,
              parsedAsJson,
            );
            if (proseFailure) {
              emitRuntimeFailed(deps, input.sessionId, manifest, proseFailure);
              return proseFailure;
            }
            const schemaFailure = checkSchemaValidation(ctx, built);
            if (schemaFailure) {
              emitRuntimeFailed(deps, input.sessionId, manifest, schemaFailure);
              return schemaFailure;
            }
            return undefined;
          }
        : undefined,
  });

  if (finalized.kind === "tool-failed") {
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

  // Observe-only normalization cross-check (docs 02 §4). The agent path keeps
  // producing its result unchanged; here we run the same unified normalizer and
  // surface any divergence as diagnostics (e.g. a legacy agent output carrying
  // a business `status: failed/skipped`, or domain effects on a non-success
  // shape). The full agent switch to the normalizer lands in a later wave.
  {
    const { outcome, diagnostics } = normalizeHandlerResult(output, {
      resultFormat: manifest.resultFormat ?? "legacy",
      runtimeType: "agent",
    });
    for (const d of diagnostics) {
      console.warn(
        `[runtime] ${manifest.name} (observe): ${d.code} — ${d.message}`,
      );
    }
    if (outcome.outcome !== "success") {
      console.warn(
        `[runtime] ${manifest.name} (observe): normalizer classified agent output as "${outcome.outcome}" but the agent path keeps status: success`,
      );
    }
  }

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

  // PostRuntime hook — agent success path. Runs BEFORE anything is
  // persisted : prompt history, commit proposals, and SSE must all see
  // the SAME finalized output. Previously the raw result was appended to
  // TurnMessages first and only the commit/SSE path saw the hook rewrite —
  // e.g. a hook downgrading success→failed still left the unrewritten
  // narrative in history.
  const result = await runPostRuntimeHook(postRuntimeOpts, rawResult);
  const finalOutput = (result.output ?? output) as Record<string, unknown>;

  // Save runtime output as an append-only TurnMessage. Manual plugin-rpc
  // calls return their output to the caller and commit proposals through
  // plugin-rpc, so they stay out of conversation history. Skipped when a
  // PostRuntime hook rewrote the status to a non-success — an unsuccessful
  // result must not enter prompt history as narrative.
  if (deps.store && !input.manualTrigger && result.status === "success") {
    // Extract narrative content.
    const narrativeContent =
      typeof finalOutput.narrativeOutput === "string"
        ? finalOutput.narrativeOutput
        : typeof finalOutput.content === "string"
          ? finalOutput.content
          : JSON.stringify(finalOutput);

    // Extract pendingInput from the interaction array.
    const interactionsArr = finalOutput.interactions as unknown[] | undefined;
    const pendingInput =
      interactionsArr && interactionsArr.length > 0
        ? interactionsArr
        : undefined;

    // Extract UI render instructions if present
    const ui = finalOutput.ui as unknown[] | undefined;

    await deps.store.appendTurnMessage({
      id: crypto.randomUUID(),
      sessionId: input.sessionId,
      turnId: input.turnId,
      sourceType: "runtime",
      sourcePluginId: manifest.pluginId,
      sourceRuntimeId: manifest.name,
      role: "assistant",
      name: manifest.name,
      content: narrativeContent,
      order: stageMessageOrder(getRuntimeSpec(manifest).stage),
      pendingInput,
      ui,
      createdAt: new Date().toISOString(),
    });
  }

  try {
    await deps.onRuntimeComplete?.({
      runtimeId: manifest.name,
      pluginId: manifest.pluginId,
      status: result.status,
      durationMs: result.durationMs,
    });
  } catch {
    /* callback error must not kill runtime */
  }

  // Emit a compact `message.completed` trace event for story runtimes that
  // produced non-empty narrative content.
  if (finalContent && manifest.outputKind === "story") {
    await emitMessageCompleted(
      deps.emitter,
      manifest,
      finalContent,
      streamDeltaCount,
    );
  }

  emitRuntimeCompleted(deps, input.sessionId, manifest, result);

  return result;
}
