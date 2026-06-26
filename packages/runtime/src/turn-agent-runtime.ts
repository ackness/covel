import type { RuntimeManifest, RuntimeResult, TurnInput } from "@covel/shared";
import type { LoadedRuntime } from "@covel/plugin-loader";
import { withPendingProposals } from "@covel/tools";
import {
  buildContext,
  buildContextAsync,
  needsAsyncBuild,
} from "@covel/context";
import type { SessionContextSnapshot } from "@covel/context";
import type { LLMMessage } from "./llm-adapter.js";
import type { HookPipeline } from "./hooks/pipeline.js";
import { resolveUserSettings } from "./turn-executor-helpers.js";
import {
  runPreRuntimeHook,
  runPostRuntimeHook,
  runPostContextAssemblyHook,
} from "./hooks/wire-helpers.js";
import { emitSubEvent } from "./turn-runtime-helpers.js";
import {
  findLastStructuredToolOutput,
  findPresentableToolOutput,
  formatToolLoopFailure,
  parseFinalOutputEnvelope,
  sanitizeStoryNarrativeText,
  shouldSuppressToolLoopNarrative,
} from "./turn-output-helpers.js";
import { filterHistoryForStory } from "./message-filter.js";
import {
  checkSchemaProseFailure,
  checkSchemaValidation,
} from "./runtime-output-validator.js";
import {
  emitMessageCompleted,
  emitRuntimeCompleted,
  emitRuntimeFailed,
} from "./runtime-telemetry.js";
import type { TurnExecutorDeps } from "./turn-executor-types.js";
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
    | readonly import("@covel/store").SessionSummaryRecord[]
    | undefined;
  readonly workingMemory:
    | readonly import("@covel/context").WorkingMemoryEntry[]
    | undefined;
  readonly coreMemoryBlocks:
    | readonly {
        label: string;
        content: string;
        updatedAt: string;
      }[]
    | undefined;
  readonly sessionContext: SessionContextSnapshot | undefined;
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
  startTime,
  runId,
}: ExecuteAgentRuntimeOptions): Promise<RuntimeResult> {
  // ── Agent runtime: LLM pipeline ─────────────────────────────
  // Emit start AFTER guard passes (or no guard exists) — prevents
  // frontend showing an infinite spinner for guard-skipped runtimes.
  try {
    await deps.onRuntimeStart?.({
      runtimeId: manifest.name,
      pluginId: manifest.pluginId,
      priority: manifest.priority,
    });
  } catch {
    /* callback error must not kill runtime */
  }
  emitSubEvent(deps.eventBus, "runtime", "runtime.started", input.sessionId, {
    runtimeId: manifest.name,
    pluginId: manifest.pluginId,
    priority: manifest.priority,
  });

  // ── PreRuntime hook (S4-T3) ──────────────────────────────────
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

  // Build context
  const config = deps.getConfig(manifest.pluginId, manifest.name);

  // TODO(S2): Tool-pair pruning safety — budget pruning does not understand
  // assistant↔tool message pairing (see T2 review I1). Skip budget injection
  // whenever this runtime declares tools via any of the three tool-declaration
  // paths: `manifest.input.tools` (dependency declarations) or
  // `manifest.tools.builtin` / `manifest.tools.local` (actual registration,
  // consumed by buildToolDefinitions). Remove this guard when pair-aware
  // pruning lands in S2.
  const inputTools = manifest.input?.tools;
  const hasInputTools = Array.isArray(inputTools) && inputTools.length > 0;
  const hasBuiltinTools =
    manifest.tools?.builtin !== undefined && manifest.tools.builtin.length > 0;
  const hasLocalTools =
    manifest.tools?.local !== undefined && manifest.tools.local.length > 0;
  const runtimeUsesTools = hasInputTools || hasBuiltinTools || hasLocalTools;
  const budgetEligible =
    !runtimeUsesTools &&
    deps.estimator !== undefined &&
    deps.contextBudget !== undefined;

  // Choose sync vs async build path based on whether the manifest
  // declares any `input.inject` entries of kind `plugin-data`. The async
  // path resolves those against the store; the sync path is unchanged
  // and handles all legacy runtime-output injects.
  // Filter message history based on runtime's outputKind.
  // Story runtimes (narrator) should only see player messages + their own
  // previous story outputs. This prevents context pollution where guide JSON,
  // codex JSON, character-tracker JSON etc. leak into the narrator prompt,
  // causing the LLM to mimic those formats.
  //
  // Filtering uses sourceRuntimeId to look up the runtime's outputKind
  // from the active manifests. Messages from runtimes not in the active set
  // are kept (conservative — don't drop unknown messages).
  const filteredHistory =
    manifest.outputKind === "story"
      ? filterHistoryForStory(messageHistory, manifest.name)
      : messageHistory;

  // Surface player-authored plugin settings to agent prompts as
  // `{{ userSettings.<key> }}`. Merge with manifest defaults so templates
  // can rely on declared keys being present; returns undefined when the
  // manifest declares no userSettings specs, which keeps the flag-off
  // branch byte-identical to the pre-ticket variables object.
  const agentUserSettings = resolveUserSettings(manifest, input.userSettings);

  const buildParams = {
    promptTemplate: loaded.promptTemplate,
    manifest,
    turnInput: input,
    completedResults,
    config,
    messageHistory: filteredHistory,
    sessionMeta,
    summaries: sessionSummaries ?? [],
    workingMemory: workingMemory ?? [],
    coreMemoryBlocks: coreMemoryBlocks ?? [],
    // Thread the unified snapshot into context building so templates can
    // read structured session data via `world`, `session`, and `player`.
    ...(sessionContext ? { sessionContext } : {}),
    ...(agentUserSettings ? { userSettings: agentUserSettings } : {}),
    ...(budgetEligible
      ? { estimator: deps.estimator, contextBudget: deps.contextBudget }
      : {}),
  } as const;

  const assembled = needsAsyncBuild({ manifest })
    ? await buildContextAsync({ ...buildParams, store: deps.store })
    : buildContext(buildParams);

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

  // Build output from LLM final content + tool call results
  let output: Record<string, unknown>;
  const presentableToolOutput = findPresentableToolOutput(executedToolCalls);
  const structuredToolOutput = findLastStructuredToolOutput(executedToolCalls);
  if (finalContent) {
    const parsed = parseFinalOutputEnvelope(finalContent);
    // Schema-declared runtimes (manifest.output.schema → loaded.outputSchema)
    // promised the framework a structured envelope. When the LLM ignores the
    // contract and produces unparseable prose, the silent narrativeOutput
    // fallback below would mask the failure: downstream event-chain followers
    // would never wake (no events[] array), and the player would see a stuck
    // job with no signal. Surface a real `failed` result with a diagnostic
    // pointing at the prose preamble — the toast / debug timeline can then
    // tell the user the model went off-script instead of timing out.
    if (
      loaded.outputSchema &&
      !parsed.parsedAsJson &&
      manifest.outputKind !== "story"
    ) {
      const failedResult = checkSchemaProseFailure(
        {
          manifest,
          input,
          runId,
          startTime,
          collectedToolCalls,
          outputSchema: loaded.outputSchema,
        },
        finalContent,
        parsed.parsedAsJson,
      );
      if (failedResult) {
        emitRuntimeFailed(deps, input.sessionId, manifest, failedResult);
        return finalizeFailure(failedResult);
      }
    }
    output = shouldSuppressToolLoopNarrative({
      outputKind: manifest.outputKind,
      executedToolCalls,
      parsedAsJson: parsed.parsedAsJson,
    })
      ? (structuredToolOutput ??
        presentableToolOutput ?? { narrativeOutput: "" })
      : parsed.output;
    if (loaded.outputSchema && manifest.outputKind !== "story") {
      const failedResult = checkSchemaValidation(
        {
          manifest,
          input,
          runId,
          startTime,
          collectedToolCalls,
          outputSchema: loaded.outputSchema,
        },
        output,
      );
      if (failedResult) {
        emitRuntimeFailed(deps, input.sessionId, manifest, failedResult);
        return finalizeFailure(failedResult);
      }
    }
  } else if (failedToolCalls.length > 0) {
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
  } else {
    output = presentableToolOutput ?? { narrativeOutput: "" };
  }

  // Extract interactions from all tool call results (generic interaction protocol).
  // Dedupe by `interactionId` — the LLM sometimes calls the same UI tool twice
  // (e.g. `create-form` with identical formId) in a single agent loop. Keeping
  // both would render two identical forms/choices in the chat, confusing the
  // player. We keep the first occurrence so the earliest presented UI wins.
  // Different interactionIds in the same turn stay independent.
  const interactions: Array<Record<string, unknown>> = [];
  const seenInteractionIds = new Set<string>();
  for (const tc of executedToolCalls) {
    if (tc.success && tc.result && typeof tc.result === "object") {
      const r = tc.result as Record<string, unknown>;
      if (r.interaction && typeof r.interaction === "object") {
        const inter = r.interaction as Record<string, unknown>;
        const id =
          typeof inter.interactionId === "string" ? inter.interactionId : "";
        // No id → pass through (UI tools should always set one; belt-and-suspenders).
        if (id && seenInteractionIds.has(id)) {
          console.warn(
            `[runtime] ${manifest.name} produced duplicate interactionId="${id}" via tool "${tc.name}"; keeping the first occurrence`,
          );
          continue;
        }
        if (id) seenInteractionIds.add(id);
        interactions.push(inter);
      }
    }
  }

  if (interactions.length > 0) {
    output.interactions = interactions;
    if (finalContent && !output.narrativeOutput) {
      output.narrativeOutput = finalContent;
    }
  }

  if (
    manifest.outputKind === "story" &&
    typeof output.narrativeOutput === "string"
  ) {
    output.narrativeOutput = sanitizeStoryNarrativeText(output.narrativeOutput);
  }

  if (pendingProposals.length > 0) {
    output = withPendingProposals(output, pendingProposals) as Record<
      string,
      unknown
    >;
  }

  const result: RuntimeResult = {
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

  // Save runtime output as an append-only TurnMessage. Manual plugin-rpc
  // calls return their output to the caller and commit proposals through
  // plugin-rpc, so they stay out of conversation history.
  if (deps.store && !input.manualTrigger) {
    // Extract narrative content.
    const narrativeContent =
      typeof output.narrativeOutput === "string"
        ? output.narrativeOutput
        : typeof output.content === "string"
          ? output.content
          : JSON.stringify(output);

    // Extract pendingInput from the interaction array.
    const interactionsArr = output.interactions as unknown[] | undefined;
    const pendingInput =
      interactionsArr && interactionsArr.length > 0
        ? interactionsArr
        : undefined;

    // Extract UI render instructions if present
    const ui = output.ui as unknown[] | undefined;

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
      order: manifest.priority ?? 500,
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

  // PostRuntime hook — agent success path (S4-T3)
  return runPostRuntimeHook(postRuntimeOpts, result);
}
