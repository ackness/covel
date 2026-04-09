/**
 * TurnExecutor — orchestrates a complete turn execution.
 *
 * Pipeline: Input → Trigger Filter → Schedule → [For each group: Context → LLM → Validate] → Result
 *
 * TODO: Define RuntimeOutput type with optional form/narrativeTemplate/ui fields
 * to replace Record<string, unknown> assertions throughout.
 */

import type { RuntimeManifest, RuntimeResult, TurnInput, TurnResult } from '@covel/shared';
import type { LoadedRuntime } from '@covel/plugin-loader';
import type { DataStore, TurnMessageRecord } from '@covel/store';
import type { EventBus } from '@covel/events';
import { shouldTrigger } from './trigger.js';
import { scheduleByPriority } from './scheduler.js';
import { buildContext } from '@covel/context';
import { executeParallel } from './parallel-executor.js';
import type { TriggerContext } from './types.js';
import type { LLMAdapter, LLMMessage } from './llm-adapter.js';
import type { ToolExecutor } from './tool-executor.js';

// ── Types ────────────────────────────────────────────────────────

export interface TurnExecutorDeps {
  /** Resolve a runtime manifest to its fully loaded data. Locale enables localized PLUGIN.md (e.g., PLUGIN.en.md). */
  readonly loadRuntime: (manifest: RuntimeManifest, locale?: string) => Promise<LoadedRuntime | undefined>;
  /** LLM adapter for making model calls. */
  readonly llm: LLMAdapter;
  /** Get effective config for a plugin/runtime. */
  readonly getConfig: (pluginId: string, runtimeId: string) => Readonly<Record<string, unknown>>;
  /** Optional DataStore for persisting results. */
  readonly store?: DataStore;
  /** Optional tool executor for handling LLM tool calls. */
  readonly toolExecutor?: ToolExecutor;
  /**
   * Resolve the effective model for a runtime.
   * Priority: API modelOverride > plugin llm.toml default > manifest.model > undefined (system default).
   */
  readonly resolveModel?: (manifest: RuntimeManifest, apiOverride?: string) => string | undefined;

  /** Optional EventBus for emitting subscription events during turn execution. */
  readonly eventBus?: EventBus;

  /** Called for each LLM text delta during streaming (narrative-only runtimes). */
  readonly onDelta?: (delta: { runtimeId: string; pluginId: string; textDelta: string }) => Promise<void>;
  /** Called when a runtime starts execution. */
  readonly onRuntimeStart?: (info: { runtimeId: string; pluginId: string; priority: number }) => Promise<void>;
  /** Called when a runtime completes execution. */
  readonly onRuntimeComplete?: (info: { runtimeId: string; pluginId: string; status: string; durationMs: number }) => Promise<void>;
}

export interface TurnExecutorOptions {
  /** Max LLM tool-calling loop steps per runtime. Default: 10. */
  readonly maxSteps?: number;
  /** Timeout per runtime in ms. Default: 60000. */
  readonly timeoutMs?: number;
}

// ── Helpers ─────────────────────────────────────────────────────

/** Emit a subscription-style event via the EventBus (if present). */
function emitSubEvent(
  eventBus: EventBus | undefined,
  subTopic: string,
  subType: string,
  sessionId: string,
  payload: Record<string, unknown>,
): void {
  if (!eventBus) return;
  eventBus.emit({
    id: crypto.randomUUID(),
    type: 'event',
    topic: subTopic,
    sessionId,
    timestamp: new Date().toISOString(),
    payload: { ...payload, _subTopic: subTopic, _subType: subType },
  });
}

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
  const timeoutMs = options?.timeoutMs ?? 60000;

  // Emit turn.started
  emitSubEvent(deps.eventBus, 'game', 'turn.started', input.sessionId, {
    turnId: input.turnId,
    sessionId: input.sessionId,
  });

  // 0. Load message history from store (append-only conversation history)
  let messageHistory: readonly TurnMessageRecord[] = [];
  if (deps.store) {
    messageHistory = await deps.store.listTurnMessages(input.sessionId);
  }

  // Save player message to the append-only history
  if (deps.store) {
    await deps.store.appendTurnMessage({
      id: crypto.randomUUID(),
      sessionId: input.sessionId,
      turnId: input.turnId,
      sourceType: 'player',
      role: 'user',
      content: input.playerMessage,
      order: 0,
      createdAt: new Date().toISOString(),
    });
  }

  // 1. Trigger filter — determine which runtimes should run this turn
  //    Each runtime gets its own triggerContext with accurate triggerCount from store.
  // Build a map of pluginId → number of times it has been triggered (from message history)
  // We use TurnMessages with sourceType='runtime' as the trigger count source
  const runtimeTriggerCounts = new Map<string, number>();
  for (const msg of messageHistory) {
    if (msg.sourceType === 'runtime' && msg.sourcePluginId) {
      runtimeTriggerCounts.set(
        msg.sourcePluginId,
        (runtimeTriggerCounts.get(msg.sourcePluginId) ?? 0) + 1,
      );
    }
  }

  const turnNumber = messageHistory.filter((m) => m.sourceType === 'player').length;

  const triggered = activeRuntimes.filter((rt) => {
    // Compute turnsSinceLastTrigger: count player messages after this runtime's last message
    let lastRuntimeMsgIdx = -1;
    for (let i = messageHistory.length - 1; i >= 0; i--) {
      const m = messageHistory[i];
      if (m.sourceType === 'runtime' && m.sourcePluginId === rt.name) {
        lastRuntimeMsgIdx = i;
        break;
      }
    }
    const turnsSinceLastTrigger = lastRuntimeMsgIdx >= 0
      ? messageHistory.slice(lastRuntimeMsgIdx).filter((m) => m.sourceType === 'player').length
      : 999;

    const triggerContext: TriggerContext = {
      sessionId: input.sessionId,
      turnNumber,
      triggerCount: runtimeTriggerCounts.get(rt.name) ?? 0,
      turnsSinceLastTrigger,
      pendingEventTopics: [],
      hasUpstreamFailure: false,
      isManualTrigger: false,
    };
    return shouldTrigger(rt, triggerContext);
  });

  // 2. Schedule by priority
  const groups = scheduleByPriority(triggered);

  // 3. Execute each group
  const completedResults = new Map<string, RuntimeResult>();

  for (const group of groups) {
    const results = await executeParallel(group.runtimes, async (manifest) => {
      return executeOneRuntime(manifest, input, completedResults, deps, maxSteps, timeoutMs, messageHistory);
    });

    // Merge results
    for (const [name, result] of results) {
      completedResults.set(name, result);
    }
  }

  // Collect pending inputs from stored TurnMessages (populated by executeOneRuntime)
  const pendingInputs: import('@covel/shared').PendingInputInfo[] = [];
  if (deps.store) {
    const turnMessages = await deps.store.listTurnMessages(input.sessionId);
    const thisTurnMessages = turnMessages.filter((m) => m.turnId === input.turnId);
    for (const msg of thisTurnMessages) {
      if (msg.pendingInput && msg.sourcePluginId) {
        const raw = msg.pendingInput;
        if (Array.isArray(raw)) {
          // New format: array of InteractionPayload
          for (const interaction of raw as Array<Record<string, unknown>>) {
            pendingInputs.push({
              pluginId: msg.sourcePluginId,
              runtimeId: msg.sourceRuntimeId ?? msg.sourcePluginId,
              interaction: interaction as unknown as import('@covel/shared').InteractionPayload,
              form: interaction.type === 'form' ? interaction as Record<string, unknown> : undefined,
              narrativeTemplate: (interaction.narrativeTemplate as string) ?? msg.content,
            });
          }
        } else {
          // Legacy format: single form object
          const form = raw as Record<string, unknown>;
          pendingInputs.push({
            pluginId: msg.sourcePluginId,
            runtimeId: msg.sourceRuntimeId ?? msg.sourcePluginId,
            interaction: {
              type: 'form',
              interactionId: (form.formId ?? '') as string,
              ...(form as object),
            } as import('@covel/shared').InteractionPayload,
            form,
            narrativeTemplate: msg.content,
          });
        }
      }
    }
  }

  const turnResult: TurnResult = {
    turnId: input.turnId,
    sessionId: input.sessionId,
    runtimeResults: [...completedResults.values()],
    pendingInputs: pendingInputs.length > 0 ? pendingInputs : undefined,
    durationMs: Date.now() - startTime,
    timestamp: new Date().toISOString(),
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
  }

  // Emit turn.completed
  emitSubEvent(deps.eventBus, 'game', 'turn.completed', input.sessionId, {
    turnId: input.turnId,
    sessionId: input.sessionId,
    durationMs: turnResult.durationMs,
  });

  return turnResult;
}

/**
 * Execute a single runtime. Dispatches to function handler or LLM agent pipeline
 * based on `manifest.runtimeType`.
 */
async function executeOneRuntime(
  manifest: RuntimeManifest,
  input: TurnInput,
  completedResults: ReadonlyMap<string, RuntimeResult>,
  deps: TurnExecutorDeps,
  maxSteps: number,
  timeoutMs: number,
  messageHistory: readonly TurnMessageRecord[],
): Promise<RuntimeResult> {
  const startTime = Date.now();
  const runId = crypto.randomUUID();

  // H2: Safe callback — don't let SSE write failures crash the runtime
  try {
    await deps.onRuntimeStart?.({
      runtimeId: manifest.name,
      pluginId: manifest.name,
      priority: manifest.priority,
    });
  } catch {
    // onRuntimeStart failure (e.g. SSE write) must not kill the runtime
  }

  emitSubEvent(deps.eventBus, 'runtime', 'runtime.started', input.sessionId, {
    runtimeId: manifest.name,
    pluginId: manifest.name,
    priority: manifest.priority,
  });

  try {
    // Load the runtime (prompt template, references, handler, etc.)
    const loaded = await deps.loadRuntime(manifest, input.locale);
    if (!loaded) {
      return makeFailedResult(manifest, input, runId, startTime, 'Runtime not found');
    }

    // ── Function runtime: direct handler execution, no LLM ──────
    if (manifest.runtimeType === 'function') {
      if (!loaded.handler) {
        return makeFailedResult(manifest, input, runId, startTime, 'Function runtime missing handler');
      }
      const config = deps.getConfig(manifest.name, manifest.name);
      const output = await loaded.handler({
        sessionId: input.sessionId,
        turnId: input.turnId,
        playerMessage: input.playerMessage,
        locale: input.locale,
        store: deps.store,
        completedResults,
        config,
      });

      const result: RuntimeResult = {
        pluginId: manifest.name,
        runtimeId: manifest.name,
        runId,
        turnId: input.turnId,
        status: 'success',
        output,
        toolCalls: [],
        durationMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      };

      // Save function output as TurnMessage (same as agent runtimes)
      if (deps.store) {
        const narrativeContent =
          typeof output.narrativeOutput === 'string' ? output.narrativeOutput :
          typeof output.content === 'string' ? output.content :
          JSON.stringify(output);

        await deps.store.appendTurnMessage({
          id: crypto.randomUUID(),
          sessionId: input.sessionId,
          turnId: input.turnId,
          sourceType: 'runtime',
          sourcePluginId: manifest.name,
          sourceRuntimeId: manifest.name,
          role: 'assistant',
          name: manifest.name,
          content: narrativeContent,
          order: manifest.priority,
          createdAt: new Date().toISOString(),
        });
      }

      await deps.onRuntimeComplete?.({
        runtimeId: manifest.name,
        pluginId: manifest.name,
        status: result.status,
        durationMs: result.durationMs,
      });

      emitSubEvent(deps.eventBus, 'runtime', 'runtime.completed', input.sessionId, {
        runtimeId: manifest.name,
        pluginId: manifest.name,
        status: result.status,
        durationMs: result.durationMs,
      });

      return result;
    }

    // ── Agent runtime: LLM pipeline ─────────────────────────────
    // Build context
    const config = deps.getConfig(manifest.name, manifest.name);
    const assembled = buildContext({
      promptTemplate: loaded.promptTemplate,
      manifest,
      turnInput: input,
      completedResults,
      config,
      messageHistory,
    });

    // Build LLM messages
    const messages: LLMMessage[] = [
      { role: 'system', content: assembled.systemPrompt },
      ...assembled.messages,
    ];

    // LLM call with tool-calling loop
    let finalContent: string | null = null;
    const toolCalls: RuntimeResult['toolCalls'] = [];
    const executedToolCalls: Array<{ name: string; arguments: string; result: unknown; success: boolean }> = [];
    let steps = 0;

    const deadline = Date.now() + timeoutMs;

    // Build tool definitions from manifest declarations (computed once, reused across steps)
    const toolDefs = deps.toolExecutor ? buildToolDefinitions(manifest, deps.toolExecutor) : undefined;

    // Use streaming for pure narrative runtimes (no tools) when callbacks are available
    const useStreaming = !!(deps.onDelta && deps.llm.stream && !toolDefs);

    while (steps < maxSteps && Date.now() < deadline) {
      steps++;

      // Model resolution chain: API override > plugin llm.toml > manifest.model > undefined
      const effectiveModel = deps.resolveModel
        ? deps.resolveModel(manifest, input.modelOverride)
        : (input.modelOverride ?? manifest.model);

      let response: import('./llm-adapter.js').LLMResponse;

      if (useStreaming) {
        // Streaming path: accumulate content from text-delta events, forward deltas to caller
        let streamedContent = '';
        let streamFinishReason = 'stop';

        for await (const event of deps.llm.stream!({
          model: effectiveModel,
          messages,
        })) {
          if (event.type === 'text-delta') {
            streamedContent += event.textDelta;
            // M1: Wrap onDelta — client disconnect should not kill the runtime
            try {
              await deps.onDelta!({
                runtimeId: manifest.name,
                pluginId: manifest.name,
                textDelta: event.textDelta,
              });
            } catch {
              // Client disconnected — continue streaming to collect full content
            }
          } else if (event.type === 'done') {
            streamFinishReason = event.finishReason;
          }
        }

        response = {
          content: streamedContent || null,
          toolCalls: [],
          finishReason: streamFinishReason as 'stop' | 'tool_calls' | 'length' | 'error',
          // M5: Streaming responses don't carry token usage from most providers.
          // The LLMStreamEvent 'done' type only has finishReason, not usage.
          // TODO: Extend LLMStreamEvent 'done' to include optional usage field
          // when providers support it (e.g. OpenAI stream_options.include_usage).
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      } else {
        // Non-streaming path: standard generate()
        response = await deps.llm.generate({
          model: effectiveModel,
          messages,
          tools: toolDefs,
        });
      }

      if (response.toolCalls.length > 0) {
        // LLM requested tool calls — execute them and feed results back.
        // Capture any narrative text produced alongside tool calls.
        if (response.content) {
          finalContent = response.content;
        }

        // Push assistant message with tool_calls (required by OpenAI protocol).
        // Without this, the next LLM call fails because tool-role messages
        // reference tool_call_ids that don't appear in any assistant message.
        messages.push({
          role: 'assistant',
          content: response.content ?? '',
          toolCalls: response.toolCalls,
        });

        for (const tc of response.toolCalls) {
          if (deps.toolExecutor) {
            const result = await deps.toolExecutor.execute(
              { toolCallId: tc.id, name: tc.name, arguments: tc.arguments },
              { sessionId: input.sessionId, turnId: input.turnId, pluginId: manifest.name, runtimeId: manifest.name },
            );

            executedToolCalls.push({
              name: tc.name,
              arguments: tc.arguments,
              result: result.parsedResult,
              success: result.success,
            });

            messages.push({
              role: 'tool',
              content: result.result,
              toolCallId: tc.id,
            });
          } else {
            messages.push({
              role: 'tool',
              content: JSON.stringify({ result: 'Tool execution not available' }),
              toolCallId: tc.id,
            });
          }
        }

        // Continue loop — LLM sees tool results and decides next action
        continue;
      }

      // Final response (no more tool calls)
      finalContent = response.content;
      break;
    }

    // Build output from LLM final content + tool call results
    let output: Record<string, unknown>;
    if (finalContent) {
      // Strip markdown code fences if present (```json ... ```)
      const stripped = finalContent.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
      try {
        output = JSON.parse(stripped) as Record<string, unknown>;
      } catch {
        // Not JSON — treat as narrative text output
        output = { narrativeOutput: finalContent };
      }
    } else {
      output = { narrativeOutput: '' };
    }

    // Extract interactions from all tool call results (generic interaction protocol)
    const interactions: Array<Record<string, unknown>> = [];
    for (const tc of executedToolCalls) {
      if (tc.success && tc.result && typeof tc.result === 'object') {
        const r = tc.result as Record<string, unknown>;
        if (r.interaction && typeof r.interaction === 'object') {
          interactions.push(r.interaction as Record<string, unknown>);
        }
      }
    }

    if (interactions.length > 0) {
      output.interactions = interactions;
      // Backward compat: also set form/narrativeTemplate for the first form interaction
      const firstForm = interactions.find(i => i.type === 'form');
      if (firstForm) {
        output.form = {
          formId: firstForm.interactionId,
          title: firstForm.title,
          fields: firstForm.fields,
          submitLabel: firstForm.submitLabel,
        };
        output.narrativeTemplate = firstForm.narrativeTemplate;
      }
      if (finalContent && !output.narrativeOutput) {
        output.narrativeOutput = finalContent;
      }
    }

    const result: RuntimeResult = {
      pluginId: manifest.name,
      runtimeId: manifest.name,
      runId,
      turnId: input.turnId,
      status: 'success',
      output,
      toolCalls,
      durationMs: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    };

    // Save runtime output as an append-only TurnMessage
    if (deps.store) {
      // Extract narrative content: try narrativeTemplate (for form-based plugins), then narrativeOutput, then stringify
      const narrativeContent =
        typeof output.narrativeTemplate === 'string' ? output.narrativeTemplate :
        typeof output.narrativeOutput === 'string' ? output.narrativeOutput :
        typeof output.content === 'string' ? output.content :
        JSON.stringify(output);

      // Extract pendingInput: prefer interactions array, fall back to legacy form
      const interactionsArr = output.interactions as unknown[] | undefined;
      const form = output.form as Record<string, unknown> | undefined;
      const pendingInput = interactionsArr && interactionsArr.length > 0
        ? interactionsArr
        : (form?.formId ? form : undefined);

      // Extract UI render instructions if present
      const ui = output.ui as unknown[] | undefined;

      await deps.store.appendTurnMessage({
        id: crypto.randomUUID(),
        sessionId: input.sessionId,
        turnId: input.turnId,
        sourceType: 'runtime',
        sourcePluginId: manifest.name,
        sourceRuntimeId: manifest.name,
        role: 'assistant',
        name: manifest.name,
        content: narrativeContent,
        order: manifest.priority,
        pendingInput,
        ui,
        createdAt: new Date().toISOString(),
      });
    }

    await deps.onRuntimeComplete?.({
      runtimeId: manifest.name,
      pluginId: manifest.name,
      status: result.status,
      durationMs: result.durationMs,
    });

    emitSubEvent(deps.eventBus, 'runtime', 'runtime.completed', input.sessionId, {
      runtimeId: manifest.name,
      pluginId: manifest.name,
      status: result.status,
      durationMs: result.durationMs,
    });

    return result;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const failedResult = makeFailedResult(manifest, input, runId, startTime, message);
    await deps.onRuntimeComplete?.({
      runtimeId: manifest.name,
      pluginId: manifest.name,
      status: failedResult.status,
      durationMs: failedResult.durationMs,
    });

    emitSubEvent(deps.eventBus, 'runtime', 'runtime.failed', input.sessionId, {
      runtimeId: manifest.name,
      pluginId: manifest.name,
      status: failedResult.status,
      durationMs: failedResult.durationMs,
      error: message,
    });

    return failedResult;
  }
}

/**
 * Build LLM tool definitions from a runtime's manifest declarations.
 * Looks up each declared tool in the ToolExecutor's registry to get its JSON schema.
 */
function buildToolDefinitions(
  manifest: RuntimeManifest,
  toolExecutor: ToolExecutor,
): import('./llm-adapter.js').LLMToolDefinition[] | undefined {
  const names: string[] = [...(manifest.tools?.builtin ?? [])];

  // For local tools, extract name from path (e.g., ./tools/unlock-codex-entries.ts → unlock-codex-entries)
  for (const p of manifest.tools?.local ?? []) {
    names.push(p.split('/').pop()?.replace(/\.[^.]+$/, '') ?? p);
  }

  if (names.length === 0) {
    return undefined;
  }

  const defs: import('./llm-adapter.js').LLMToolDefinition[] = [];

  for (const name of names) {
    const info = toolExecutor.getToolInfo(name);
    if (info) {
      defs.push({
        name: info.name,
        description: info.description,
        parameters: info.jsonSchema as Record<string, unknown>,
      });
    } else {
      // Tool not found in registry — add a minimal definition so LLM knows it exists
      defs.push({
        name,
        description: `Tool: ${name}`,
        parameters: { type: 'object' },
      });
    }
  }

  return defs.length > 0 ? defs : undefined;
}

function makeFailedResult(
  manifest: RuntimeManifest,
  input: TurnInput,
  runId: string,
  startTime: number,
  error: string,
): RuntimeResult {
  return {
    pluginId: manifest.name,
    runtimeId: manifest.name,
    runId,
    turnId: input.turnId,
    status: 'failed',
    output: null,
    toolCalls: [],
    durationMs: Date.now() - startTime,
    error,
    timestamp: new Date().toISOString(),
  };
}
