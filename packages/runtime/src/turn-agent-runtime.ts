import type { RuntimeManifest, RuntimeResult, TurnInput } from "@covel/shared";
import type { LoadedRuntime } from "@covel/plugin-loader";
import { validateOutput, withPendingProposals } from "@covel/tools";
import {
  buildContext,
  buildContextAsync,
  needsAsyncBuild,
} from "@covel/context";
import type { SessionContextSnapshot } from "@covel/context";
import type { LLMMessage } from "./llm-adapter.js";
import type { HookPipeline } from "./hooks/pipeline.js";
import { resolveUserSettings } from "./turn-executor-helpers.js";
import { runPreRuntimeHook, runPostRuntimeHook } from "./hooks/wire-helpers.js";
import { emitSubEvent } from "./turn-runtime-helpers.js";
import {
  extractRequiredFields,
  findLastStructuredToolOutput,
  findPresentableToolOutput,
  formatToolLoopFailure,
  looksLikeStructuredRuntimeOutput,
  parseFinalOutputEnvelope,
  sanitizeStoryNarrativeText,
  shouldSuppressToolLoopNarrative,
} from "./turn-output-helpers.js";
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
  let filteredHistory = messageHistory;
  if (manifest.outputKind === "story") {
    filteredHistory = messageHistory.filter((m) => {
      if (m.sourceType === "player" || m.sourceType === "system") return true;
      if (m.sourceType === "runtime") {
        // Keep own previous outputs.
        if (m.sourceRuntimeId === manifest.name) return true;
        // Filter out messages that look like structured tool output so the
        // narrator doesn't mimic JSON / block / category-list formats.
        if (looksLikeStructuredRuntimeOutput(m.content)) return false;
        // Keep narrative-like text from other runtimes.
        return true;
      }
      return true;
    });
  }

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

  // Build LLM messages
  const messages: LLMMessage[] = [
    { role: "system", content: assembled.systemPrompt },
    ...assembled.messages,
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

  if (!stoppedWithResponse && !finalContent) {
    const result: RuntimeResult = {
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
    };

    return runPostRuntimeHook(
      {
        pipeline: hookPipeline,
        sessionId: input.sessionId,
        turnId: input.turnId,
        pluginId: manifest.pluginId,
        runtimeId: manifest.name,
        eventBus: deps.eventBus,
        emitter: deps.emitter,
      },
      result,
    );
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
      const preview = finalContent.slice(0, 220).replace(/\s+/g, " ").trim();
      const requiredFields = extractRequiredFields(loaded.outputSchema);
      const requiredHint =
        requiredFields.length > 0
          ? ` Required fields: {${requiredFields.join(", ")}}.`
          : "";
      const failedResult: RuntimeResult = {
        pluginId: manifest.pluginId,
        runtimeId: manifest.name,
        runId,
        turnId: input.turnId,
        status: "failed",
        // Preserve the full LLM output (`narrativeOutput`) plus a structured
        // diagnostic the task UI can render verbatim. The shape is stable so
        // a plugin's jobs.json can bind `value/runtimeResults/0/output/diagnostic`
        // and show the user the schema contract + raw output side-by-side.
        output: {
          narrativeOutput: finalContent,
          diagnostic: {
            kind: "schema-validation-prose",
            requiredFields,
            schemaTitle:
              typeof loaded.outputSchema.title === "string"
                ? loaded.outputSchema.title
                : undefined,
            llmOutput: finalContent,
            hint:
              "Model returned plain prose instead of JSON. Try a model with reliable structured-output mode, " +
              "tighten the system prompt to enforce JSON, or relax overly strict schema fields.",
          },
        },
        toolCalls: collectedToolCalls,
        durationMs: Date.now() - startTime,
        error:
          `Runtime "${manifest.name}" expected a JSON envelope per output.schema but the model returned plain prose.` +
          requiredHint +
          ` Full LLM output preserved in runtimeResults[].output.narrativeOutput.` +
          ` Preview: "${preview}${finalContent.length > 220 ? "…" : ""}"`,
        timestamp: new Date().toISOString(),
      };
      emitSubEvent(
        deps.eventBus,
        "runtime",
        "runtime.failed",
        input.sessionId,
        {
          runtimeId: manifest.name,
          pluginId: manifest.pluginId,
          status: failedResult.status,
          durationMs: failedResult.durationMs,
          error: failedResult.error,
        },
      );
      return runPostRuntimeHook(
        {
          pipeline: hookPipeline,
          sessionId: input.sessionId,
          turnId: input.turnId,
          pluginId: manifest.pluginId,
          runtimeId: manifest.name,
          eventBus: deps.eventBus,
          emitter: deps.emitter,
        },
        failedResult,
      );
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
      const validation = validateOutput(output, loaded.outputSchema);
      if (!validation.valid) {
        const validationErrors = validation.errors ?? [
          "unknown schema validation error",
        ];
        const failedResult: RuntimeResult = {
          pluginId: manifest.pluginId,
          runtimeId: manifest.name,
          runId,
          turnId: input.turnId,
          status: "failed",
          output,
          toolCalls: collectedToolCalls,
          durationMs: Date.now() - startTime,
          error:
            `Runtime "${manifest.name}" output did not match output.schema: ` +
            validationErrors.slice(0, 5).join("; "),
          timestamp: new Date().toISOString(),
        };
        emitSubEvent(
          deps.eventBus,
          "runtime",
          "runtime.failed",
          input.sessionId,
          {
            runtimeId: manifest.name,
            pluginId: manifest.pluginId,
            status: failedResult.status,
            durationMs: failedResult.durationMs,
            error: failedResult.error,
          },
        );
        return runPostRuntimeHook(
          {
            pipeline: hookPipeline,
            sessionId: input.sessionId,
            turnId: input.turnId,
            pluginId: manifest.pluginId,
            runtimeId: manifest.name,
            eventBus: deps.eventBus,
            emitter: deps.emitter,
          },
          failedResult,
        );
      }
    }
  } else if (failedToolCalls.length > 0) {
    const result: RuntimeResult = {
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
    };

    return runPostRuntimeHook(
      {
        pipeline: hookPipeline,
        sessionId: input.sessionId,
        turnId: input.turnId,
        pluginId: manifest.pluginId,
        runtimeId: manifest.name,
        eventBus: deps.eventBus,
        emitter: deps.emitter,
      },
      result,
    );
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
  // produced non-empty narrative content. The realtime `message.delta`
  // channel keeps flowing per-token; this event is the single persisted
  // record of the final aggregated content and the delta count, so the
  // `/debug` timeline shows one row per runtime output instead of
  // thousands of per-token rows.
  if (deps.emitter && finalContent && manifest.outputKind === "story") {
    await deps.emitter.emit("message.completed", {
      runtimeId: manifest.name,
      pluginId: manifest.pluginId,
      content: finalContent,
      len: finalContent.length,
      deltaCount: streamDeltaCount,
    });
  }

  emitSubEvent(deps.eventBus, "runtime", "runtime.completed", input.sessionId, {
    runtimeId: manifest.name,
    pluginId: manifest.pluginId,
    status: result.status,
    durationMs: result.durationMs,
  });

  // PostRuntime hook — agent success path (S4-T3)
  return runPostRuntimeHook(
    {
      pipeline: hookPipeline,
      sessionId: input.sessionId,
      turnId: input.turnId,
      pluginId: manifest.pluginId,
      runtimeId: manifest.name,
      eventBus: deps.eventBus,
      emitter: deps.emitter,
    },
    result,
  );
}
