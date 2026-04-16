/**
 * TurnExecutor — orchestrates a complete turn execution.
 *
 * Pipeline: Input → Trigger Filter → Schedule → [For each group: Context → LLM → Validate] → Result
 *
 * Note: RuntimeOutput is intentionally Record<string, unknown> — plugins produce
 * arbitrary output shapes. The session kernel normalizes them into typed Proposals.
 */

import type { RuntimeManifest, RuntimeResult, TurnInput, TurnResult, ToolCallRecord } from '@covel/shared';
import type { LoadedRuntime } from '@covel/plugin-loader';
import type {
  DataStore,
  TurnMessageRecord,
  SuspensionRecord,
  RuntimeOutputRecord,
} from '@covel/store';
import { isSuspendSentinel } from '@covel/tools';
import type { EventBus } from '@covel/events';
import { shouldTrigger } from './trigger.js';
import { scheduleByPriority } from './scheduler.js';
import { buildContext, buildContextAsync, needsAsyncBuild } from '@covel/context';
import type { BudgetOptions, TokenEstimator, CompactorRunner } from '@covel/context';
import { executeParallel } from './parallel-executor.js';
import type { TriggerContext } from './types.js';
import type { LLMAdapter, LLMMessage } from './llm-adapter.js';
import type { ToolExecutor } from './tool-executor.js';
import type { HookPipeline } from './hooks/pipeline.js';
import { buildToolDefinitions, makeFailedResult } from './turn-executor-helpers.js';
import {
  runTurnStartHook,
  runTurnStopHook,
  runPreRuntimeHook,
  runPostRuntimeHook,
  runPreToolUseHook,
  runPostToolUseHook,
} from './hooks/wire-helpers.js';

// ── Types ────────────────────────────────────────────────────────

interface ExecutedToolCallState {
  readonly name: string;
  readonly arguments: string;
  readonly result: unknown;
  readonly success: boolean;
}

interface FailedToolCallState {
  readonly toolName: string;
  readonly message?: string;
}

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

  /**
   * Optional token estimator for context budgeting. When provided together with
   * `contextBudget` AND `process.env.COVEL_CONTEXT_BUDGET_V1 === '1'`, the message
   * history is pruned before it is handed to the LLM. See packages/context/src/budget.ts.
   *
   * Turn-executor does NOT read the env flag itself — that check lives in
   * `buildContext`. Turn-executor only threads these references through.
   */
  readonly estimator?: TokenEstimator;

  /**
   * Optional budget configuration. Only honored when `estimator` is also present.
   * Same shape as `BudgetOptions` from @covel/context minus the `estimator` field
   * (which is threaded separately so callers can share one estimator across many
   * runtimes).
   */
  readonly contextBudget?: Omit<BudgetOptions, 'estimator'>;

  /**
   * Optional hook pipeline (S4-T3).
   * When present AND `process.env.COVEL_HOOKS_V1 === '1'`, lifecycle hooks
   * fire at 8 points during turn execution. When absent or flag is off,
   * all hook sites are pure no-ops — identical to pre-S4-T3 behaviour.
   */
  readonly hookPipeline?: HookPipeline;

  /**
   * Optional compactor runner (S2-T2).
   * When present AND `process.env.COVEL_COMPACTOR_V1 === '1'`, the compactor
   * runs before `buildContext` to summarize old history. When absent or flag
   * is off, the compaction step is a pure no-op — identical to pre-S2-T2
   * behaviour.
   */
  readonly compactor?: CompactorRunner;

  /**
   * Optional memory system (Letta-style three-tier memory).
   * When present AND `process.env.COVEL_MEMORY_V1 === '1'`:
   *   - Pre-turn: loads core memory blocks and passes to buildContext
   *   - Post-turn: calls memory updater to refresh blocks from turn results
   * When absent or flag off: zero overhead, identical to pre-memory behaviour.
   */
  readonly memorySystem?: {
    readonly manager: {
      loadBlocks(sessionId: string): Promise<readonly { label: string; content: string; updatedAt: string }[]>;
      initializeDefaults(sessionId: string): Promise<void>;
    };
    readonly updater: {
      updateAfterTurn(params: {
        sessionId: string;
        narrativeText: string;
        toolCallSummaries?: readonly string[];
        currentBlocks: readonly { label: string; content: string; updatedAt: string }[];
        locale?: string;
      }): Promise<{ updated: boolean; blocksChanged: readonly string[]; error?: string }>;
    };
  };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseFinalOutput(finalContent: string): Record<string, unknown> {
  const stripped = finalContent.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
  try {
    return JSON.parse(stripped) as Record<string, unknown>;
  } catch {
    return { narrativeOutput: finalContent };
  }
}

function parseFinalOutputEnvelope(finalContent: string): {
  readonly output: Record<string, unknown>;
  readonly parsedAsJson: boolean;
} {
  const stripped = finalContent.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
  try {
    return {
      output: JSON.parse(stripped) as Record<string, unknown>,
      parsedAsJson: true,
    };
  } catch {
    return {
      output: { narrativeOutput: finalContent },
      parsedAsJson: false,
    };
  }
}

function shouldSuppressToolLoopNarrative(args: {
  outputKind?: string;
  executedToolCalls: readonly ExecutedToolCallState[];
  parsedAsJson: boolean;
}): boolean {
  return (
    args.outputKind === 'system' &&
    args.executedToolCalls.length > 0 &&
    !args.parsedAsJson
  );
}

function findPresentableToolOutput(executedToolCalls: readonly ExecutedToolCallState[]): Record<string, unknown> | null {
  for (let i = executedToolCalls.length - 1; i >= 0; i--) {
    const result = executedToolCalls[i]?.result;
    if (!isRecord(result)) continue;
    if (Array.isArray(result.ui) || isRecord(result.interaction)) {
      return { ...result };
    }
  }
  return null;
}

function findLastStructuredToolOutput(executedToolCalls: readonly ExecutedToolCallState[]): Record<string, unknown> | null {
  for (let i = executedToolCalls.length - 1; i >= 0; i--) {
    const result = executedToolCalls[i]?.result;
    if (isRecord(result)) return { ...result };
  }
  return null;
}

function extractToolFailureMessage(result: string): string | undefined {
  try {
    const parsed = JSON.parse(result) as { error?: unknown };
    if (typeof parsed.error === 'string' && parsed.error.length > 0) {
      return parsed.error;
    }
  } catch {
    // Ignore parse failures and fall back to the raw text below.
  }
  return result.length > 0 ? result : undefined;
}

function formatToolLoopFailure(args: {
  runtimeId: string;
  reason: 'max_steps' | 'timeout' | 'tool_failed_without_output';
  maxSteps?: number;
  failedToolCalls: readonly FailedToolCallState[];
}): string {
  const reasonText =
    args.reason === 'max_steps'
      ? `exhausted the tool loop after ${args.maxSteps ?? 0} steps without producing final output`
      : args.reason === 'timeout'
        ? 'timed out while waiting for final output after tool execution'
        : 'stopped without final output after a tool failure';
  const lastFailure = args.failedToolCalls.at(-1);
  if (!lastFailure) {
    return `Runtime "${args.runtimeId}" ${reasonText}.`;
  }
  return `Runtime "${args.runtimeId}" ${reasonText}. Last tool failure: ${lastFailure.toolName}${lastFailure.message ? ` — ${lastFailure.message}` : ''}`;
}

function shouldRetryMalformedToolArguments(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('function.arguments') && message.includes('JSON format');
}

function isMetaChoiceParagraph(paragraph: string): boolean {
  const plain = paragraph.replace(/\*\*/g, '').trim();
  return /^(?:现在，你需要(?:做出选择|做出决定)|你的选择是|你需要决定|你要如何选择|你会怎么做|请选择)/u.test(plain);
}

function sanitizeStoryNarrativeText(content: string): string {
  const paragraphs = content
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  while (paragraphs.length > 0 && isMetaChoiceParagraph(paragraphs[paragraphs.length - 1]!)) {
    paragraphs.pop();
  }

  return paragraphs.join('\n\n').trim();
}

/**
 * PR-1 translation layer: convert a `RuntimeResult` (the internal execution
 * record) into a `RuntimeOutputRecord` (the normalised, consumable record).
 *
 * This is a lossy projection — the goal is NOT to store the full prompt
 * history (that lives in `turn_messages` and can be rebuilt), but to give
 * downstream consumers a stable, cross-runtime shape with a human-readable
 * `text` field and a plugin-defined `structured` blob.
 *
 * `rawPromptDelta` is intentionally left undefined in this first iteration.
 * Wiring the actual prompt-delta source into the agent loop is a follow-up
 * once the adapter exposes "what messages were sent on this call".
 */
function buildRuntimeOutputFromResult(
  rr: RuntimeResult,
  sessionId: string,
  turn: number,
  phase: string,
  createdAt: string,
): RuntimeOutputRecord {
  const output = rr.output as Record<string, unknown> | null;

  // Pull a natural-language summary from common fields, fall back to JSON.
  const narrativeOutput =
    output && typeof output['narrativeOutput'] === 'string'
      ? (output['narrativeOutput'] as string)
      : null;
  const textValue =
    output && typeof output['_text'] === 'string'
      ? (output['_text'] as string)
      : null;
  const summaryText =
    narrativeOutput ?? textValue ?? (output ? JSON.stringify(output) : '');

  const toolCallList = rr.toolCalls.map((tc: ToolCallRecord) => ({
    tool: tc.toolName,
    input: tc.input,
    output: tc.output,
    status: 'success' as const,
    durationMs: tc.durationMs,
  }));

  return {
    id: crypto.randomUUID(),
    sessionId,
    turnId: rr.turnId,
    runtimeResultId: rr.runId,
    pluginId: rr.pluginId,
    runtimeId: rr.runtimeId,
    timestamp: rr.timestamp ?? createdAt,
    results: [
      {
        text: summaryText,
        structured: output ?? undefined,
      },
    ],
    metaData: {
      turn,
      phase,
      toolCallList: toolCallList.length > 0 ? toolCallList : undefined,
      tokenUsage: rr.tokenUsage,
      // rawPromptDelta / outputResponses / modelSlot: not populated in PR-1
    },
    createdAt,
  };
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
  const defaultTimeoutMs = options?.timeoutMs ?? 60000;

  // Emit turn.started
  emitSubEvent(deps.eventBus, 'game', 'turn.started', input.sessionId, {
    turnId: input.turnId,
    sessionId: input.sessionId,
  });

  // ── TurnStart hook (S4-T3) ───────────────────────────────────
  {
    const tsResult = await runTurnStartHook(
      { pipeline: deps.hookPipeline, sessionId: input.sessionId, turnId: input.turnId, eventBus: deps.eventBus },
      { playerMessage: input.playerMessage, activeRuntimes: activeRuntimes.map((r) => r.name) },
    );
    if (tsResult.action === 'abort') {
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

  // 0. Load message history from store (append-only conversation history)
  let messageHistory: readonly TurnMessageRecord[] = [];
  if (deps.store) {
    messageHistory = await deps.store.listTurnMessages(input.sessionId);
  }

  // turnNumber = number of player messages BEFORE the current one.
  // Must be computed from the pre-append history to preserve 0-based semantics
  // that interval-based triggers depend on (e.g. interval:2 fires at 0,2,4…).
  const turnNumber = messageHistory.filter((m) => m.sourceType === 'player').length;

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
    // Reload so messageHistory includes the current player message.
    // This ensures turnsSinceLastTrigger counts the current turn correctly —
    // without this, cooldownTurns checks always see 0 player messages after
    // the last runtime message, blocking plugins like core-guide on every
    // subsequent turn.
    messageHistory = await deps.store.listTurnMessages(input.sessionId);
  }

  // 0b. Compaction (S2-T2): run before buildContext so summaries are stored
  //     before the turn's context assembly reads them.
  //     Only runs when COVEL_COMPACTOR_V1=1 AND a compactor is injected.
  if (process.env.COVEL_COMPACTOR_V1 === '1' && deps.compactor && deps.store) {
    // Reload messages after appending the player message so the compactor
    // sees the full updated history (including the just-appended player msg).
    const freshMessages = await deps.store.listTurnMessages(input.sessionId);
    await deps.compactor.run(input.sessionId, '', freshMessages);
    // Reload the history for subsequent processing (trigger counts, etc.)
    messageHistory = await deps.store.listTurnMessages(input.sessionId);
  }

  // 1. Trigger filter — determine which runtimes should run this turn
  //    Each runtime gets its own triggerContext with accurate triggerCount from store.
  // Build a map of runtimeId → number of times it has been triggered (from message history)
  // We use TurnMessages with sourceType='runtime' as the trigger count source.
  // Key by sourceRuntimeId (e.g. "core-world-init/schema-gen") to match rt.name used in lookup,
  // since sourcePluginId stores the plugin package ID (e.g. "core-world-init") which differs for
  // multi-runtime plugins.
  const runtimeTriggerCounts = new Map<string, number>();
  for (const msg of messageHistory) {
    if (msg.sourceType === 'runtime' && msg.sourceRuntimeId) {
      runtimeTriggerCounts.set(
        msg.sourceRuntimeId,
        (runtimeTriggerCounts.get(msg.sourceRuntimeId) ?? 0) + 1,
      );
    }
  }

  // Load session metadata for context injection (turnNumber, phase, characters, lastFormValues)
  let sessionPhase: string | undefined;
  let sessionPlayingTurnOffset: number | null | undefined;
  let sessionCharacters: { name: string; type: string; description?: string; fields?: Record<string, unknown> }[] = [];
  let lastFormValues: Record<string, unknown> | undefined;
  if (deps.store) {
    const session = await deps.store.getSession(input.sessionId);
    if (session) {
      sessionPhase = session.phase;
      sessionPlayingTurnOffset = session.playingTurnOffset;
    }

    // PR-2: lazily set playingTurnOffset the first time a turn runs while
    // phase is 'playing'. After this the offset is frozen for the session
    // lifetime and playingTurnNumber = turnNumber - offset.
    if (
      sessionPhase === 'playing'
      && (sessionPlayingTurnOffset == null || sessionPlayingTurnOffset === undefined)
    ) {
      sessionPlayingTurnOffset = turnNumber;
      try {
        await deps.store.updateSession(input.sessionId, {
          playingTurnOffset: turnNumber,
          updatedAt: new Date().toISOString(),
        });
      } catch (err) {
        console.warn(
          '[turn-executor] updateSession(playingTurnOffset) failed:',
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    const charRecords = await deps.store.listCharacters(input.sessionId);
    sessionCharacters = charRecords.map(c => ({
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
        if (latest?.values && typeof latest.values === 'object') {
          lastFormValues = latest.values as Record<string, unknown>;
        }
      }
    } catch {
      // Non-critical: player inputs may not exist yet
    }
  }
  let sessionMeta = { turnNumber, phase: sessionPhase ?? 'unknown', characters: sessionCharacters, lastFormValues };
  const promptHistory = messageHistory.filter(
    (msg) => !(msg.turnId === input.turnId && msg.sourceType === 'player'),
  );

  const triggered = activeRuntimes.filter((rt) => {
    // Compute turnsSinceLastTrigger: count player messages after this runtime's last message
    let lastRuntimeMsgIdx = -1;
    for (let i = messageHistory.length - 1; i >= 0; i--) {
      const m = messageHistory[i];
      if (m.sourceType === 'runtime' && m.sourceRuntimeId === rt.name) {
        lastRuntimeMsgIdx = i;
        break;
      }
    }
    const turnsSinceLastTrigger = lastRuntimeMsgIdx >= 0
      ? messageHistory.slice(lastRuntimeMsgIdx).filter((m) => m.sourceType === 'player').length
      : 999;

    // PR-2: compute playing-phase turn counter. Only meaningful when the
    // session is currently in 'playing' phase; otherwise left at 0 so
    // startTurn comparisons never fire during pre-game / char-creation.
    const playingTurnNumber =
      sessionPhase === 'playing' && sessionPlayingTurnOffset != null
        ? Math.max(0, turnNumber - sessionPlayingTurnOffset)
        : 0;

    const triggerContext: TriggerContext = {
      sessionId: input.sessionId,
      turnNumber,
      playingTurnNumber,
      triggerCount: runtimeTriggerCounts.get(rt.name) ?? 0,
      turnsSinceLastTrigger,
      pendingEventTopics: [],
      hasUpstreamFailure: false,
      isManualTrigger: false,
      sessionPhase,
    };
    return shouldTrigger(rt, triggerContext);
  });

  // 2. Schedule by priority
  const groups = scheduleByPriority(triggered);

  // Load session summaries for compaction substitution in buildContext (S2-T2)
  let sessionSummaries: import('@covel/store').SessionSummaryRecord[] = [];
  if (process.env.COVEL_COMPACTOR_V1 === '1' && deps.store) {
    sessionSummaries = [...(await deps.store.listSessionSummaries(input.sessionId))];
  }

  // Load working memory for prompt injection (S3-T3, B1 fix).
  // The store may not implement listWorkingMemory on older backends, so we
  // probe for the method before calling. The downstream context-builder gates
  // actual rendering on COVEL_WORKING_MEMORY_V1=1, so loading here is cheap
  // and idempotent — when the flag is off, the loaded entries are simply not
  // rendered into the system prompt.
  let workingMemory: readonly import('@covel/context').WorkingMemoryEntry[] = [];
  if (deps.store && typeof deps.store.listWorkingMemory === 'function') {
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
  let coreMemoryBlocks: readonly { label: string; content: string; updatedAt: string }[] = [];
  if (process.env.COVEL_MEMORY_V1 === '1' && deps.memorySystem) {
    try {
      await deps.memorySystem.manager.initializeDefaults(input.sessionId);
      coreMemoryBlocks = await deps.memorySystem.manager.loadBlocks(input.sessionId);
    } catch {
      // Non-critical: memory load failures must not abort the turn.
      coreMemoryBlocks = [];
    }
  }

  // 3. Execute each group
  const completedResults = new Map<string, RuntimeResult>();

  for (const group of groups) {
    const results = await executeParallel(group.runtimes, async (manifest) => {
      return executeOneRuntime(manifest, input, completedResults, deps, maxSteps, defaultTimeoutMs, promptHistory, sessionMeta, deps.hookPipeline, sessionSummaries, workingMemory, coreMemoryBlocks);
    });

    // Merge results + apply phase transitions from runtime output
    for (const [name, result] of results) {
      completedResults.set(name, result);
      const outputPhase = result.output && typeof (result.output as Record<string, unknown>).phase === 'string'
        ? (result.output as Record<string, unknown>).phase as string
        : undefined;
      if (outputPhase && deps.store) {
        sessionMeta = { ...sessionMeta, phase: outputPhase };
        await deps.store.updateSession(input.sessionId, { phase: outputPhase });
      }
    }
  }

  // Collect pending inputs from completed RuntimeResults (avoids redundant DB reload)
  const pendingInputs: import('@covel/shared').PendingInputInfo[] = [];
  for (const [, result] of completedResults) {
    if (!result.output) continue;
    const out = result.output as Record<string, unknown>;
    const interactions = out.interactions as Array<Record<string, unknown>> | undefined;
    const form = out.form as Record<string, unknown> | undefined;
    const narrativeFallback =
      typeof out.narrativeTemplate === 'string' ? out.narrativeTemplate :
      typeof out.narrativeOutput === 'string' ? out.narrativeOutput :
      '';

    if (interactions && interactions.length > 0) {
      for (const interaction of interactions) {
        pendingInputs.push({
          pluginId: result.pluginId,
          runtimeId: result.runtimeId,
          interaction: interaction as unknown as import('@covel/shared').InteractionPayload,
          form: interaction.type === 'form' ? interaction as Record<string, unknown> : undefined,
          narrativeTemplate: (interaction.narrativeTemplate as string) ?? narrativeFallback,
        });
      }
    } else if (form?.formId) {
      // Legacy format: single form object
      pendingInputs.push({
        pluginId: result.pluginId,
        runtimeId: result.runtimeId,
        interaction: {
          type: 'form',
          interactionId: (form.formId ?? '') as string,
          ...(form as object),
        } as import('@covel/shared').InteractionPayload,
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
          buildRuntimeOutputFromResult(
            rr,
            input.sessionId,
            turnNumber,
            sessionPhase ?? 'unknown',
            now,
          ),
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
    if (process.env['COVEL_SNAPSHOTS_V1'] === '1') {
      try {
        const { buildSnapshotPayload } = await import('./snapshot-payload-builder.js');
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
          kind: 'auto',
          payload,
          createdAt: turnResult.timestamp ?? now,
        });
        // Emit SSE event so reactive UI can refresh snapshot lists.
        // Topic 'session' matches the session.forked convention; the
        // SSE forwarder picks `_subType` as the named event field.
        emitSubEvent(deps.eventBus, 'session', 'state.snapshot.created', input.sessionId, {
          turnId: input.turnId,
          snapshotId,
          kind: 'auto',
        });
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
  emitSubEvent(deps.eventBus, 'game', 'turn.completed', input.sessionId, {
    turnId: input.turnId,
    sessionId: input.sessionId,
    durationMs: turnResult.durationMs,
  });

  // ── Post-turn memory update (Letta-style) ─────────────────────
  // Fire-and-forget: memory update runs asynchronously so it doesn't
  // block the turn response. Stale-by-one-turn is acceptable.
  if (process.env.COVEL_MEMORY_V1 === '1' && deps.memorySystem && coreMemoryBlocks.length > 0) {
    // Collect narrative text from all successful runtimes
    const narrativeParts: string[] = [];
    for (const rr of turnResult.runtimeResults) {
      const out = rr.output as Record<string, unknown> | null;
      const text = (out?.narrativeOutput as string) ?? (out?.text as string) ?? '';
      if (text.trim()) narrativeParts.push(text);
    }
    const narrativeText = narrativeParts.join('\n\n');

    // eslint-disable-next-line no-console
    console.log(`[memory] post-turn: ${narrativeParts.length} narrative parts, ${narrativeText.length} chars, statuses: [${turnResult.runtimeResults.map((r) => `${r.runtimeId}:${r.status}`).join(', ')}]`);

    if (narrativeText.trim()) {
      const toolSummaries = turnResult.runtimeResults
        .flatMap((rr) => rr.toolCalls.map((tc) => `[${tc.toolName}] ${JSON.stringify(tc.input).slice(0, 200)}`));

      deps.memorySystem.updater.updateAfterTurn({
        sessionId: input.sessionId,
        narrativeText,
        toolCallSummaries: toolSummaries.length > 0 ? toolSummaries : undefined,
        currentBlocks: coreMemoryBlocks,
        locale: input.locale,
      }).then((result) => {
        // eslint-disable-next-line no-console
        console.log(`[memory] update result: updated=${result.updated}, blocks=[${result.blocksChanged.join(',')}]${result.error ? `, error=${result.error}` : ''}`);
      }).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn(
          `[turn-executor] memory update failed for ${input.sessionId}:`,
          err instanceof Error ? err.message : String(err),
        );
      });
    } else {
      // eslint-disable-next-line no-console
      console.log('[memory] post-turn: no narrative text found, skipping memory update');
    }
  }

  // ── TurnStop hook (S4-T3) — Post* hooks cannot abort ────────
  await runTurnStopHook(
    { pipeline: deps.hookPipeline, sessionId: input.sessionId, turnId: input.turnId, eventBus: deps.eventBus },
    { runtimeResults: turnResult.runtimeResults, durationMs: turnResult.durationMs },
  );

  return turnResult;
}

// ── Resume (S4-T4) ───────────────────────────────────────────────

export interface ResumeSuspendedRuntimeOptions {
  readonly maxSteps?: number;
  readonly timeoutMs?: number;
}

/**
 * Re-enter the LLM tool loop for a suspended agent runtime (S4-T4).
 *
 * This function:
 * 1. Reconstructs the LLM message array from `pendingContinuation.messages`.
 * 2. Appends a synthetic `tool` message carrying `resumeData` (for agent runtimes)
 *    or a `user` message (for function runtimes that suspended via status).
 * 3. Drives the LLM tool-calling loop to completion.
 * 4. Marks the suspension as resolved in the store.
 * 5. Emits `turn.resumed` SSE event.
 *
 * Provider API keys are never stored; they must be supplied via the current request.
 *
 * NOTE: COVEL_SUSPEND_V1 must be '1' — callers check this before invoking.
 */
export async function resumeSuspendedRuntime(
  suspension: SuspensionRecord,
  resumeData: unknown,
  manifest: RuntimeManifest,
  deps: TurnExecutorDeps,
  options?: ResumeSuspendedRuntimeOptions,
): Promise<RuntimeResult> {
  const startTime = Date.now();
  const maxSteps = options?.maxSteps ?? 10;
  const timeoutMs = options?.timeoutMs ?? manifest.timeoutMs ?? 60000;
  const runId = crypto.randomUUID();

  const { pendingContinuation } = suspension;

  // Reconstruct message array from stored continuation
  const messages: LLMMessage[] = [...(pendingContinuation.messages as LLMMessage[])];

  // Append synthetic message to deliver resume data to the LLM.
  // For agent runtimes (suspended via suspend tool), append as a 'tool' message
  // referencing the suspend tool's call ID. For function runtimes, append as 'user'.
  if (pendingContinuation.suspendToolCallId) {
    // Agent runtime path: synthetic tool result carrying resume data
    messages.push({
      role: 'tool',
      content: JSON.stringify({ resumeData }),
      toolCallId: pendingContinuation.suspendToolCallId,
    });
  } else {
    // Function runtime path: resume data delivered as user message
    messages.push({
      role: 'user',
      content: typeof resumeData === 'string' ? resumeData : JSON.stringify(resumeData),
    });
  }

  // Load the runtime to get toolDefs etc.
  const loaded = await deps.loadRuntime(manifest, undefined);
  if (!loaded) {
    return {
      pluginId: manifest.pluginId,
      runtimeId: manifest.name,
      runId,
      turnId: suspension.turnId,
      status: 'failed',
      output: null,
      toolCalls: [],
      durationMs: Date.now() - startTime,
      error: 'Runtime not found on resume',
      timestamp: new Date().toISOString(),
    };
  }

  const collectedToolCalls: ToolCallRecord[] = [...(pendingContinuation.toolCallsSoFar as ToolCallRecord[])];
  const executedToolCalls: ExecutedToolCallState[] = [];
  const failedToolCalls: FailedToolCallState[] = [];
  let finalContent: string | null = pendingContinuation.partialContent ?? null;
  let steps = 0;
  const deadline = Date.now() + timeoutMs;
  let stoppedWithResponse = false;

  const toolDefs = deps.toolExecutor ? buildToolDefinitions(manifest, deps.toolExecutor) : undefined;

  while (steps < maxSteps && Date.now() < deadline) {
    steps++;

    const effectiveModel = deps.resolveModel
      ? deps.resolveModel(manifest, undefined)
      : manifest.model;

    const response = await deps.llm.generate({
      model: effectiveModel,
      messages,
      tools: toolDefs,
    });

    if (response.toolCalls.length > 0) {
      if (response.content) finalContent = response.content;

      messages.push({
        role: 'assistant',
        content: response.content ?? '',
        toolCalls: response.toolCalls,
      });

      for (const tc of response.toolCalls) {
        if (deps.toolExecutor) {
          const tcStart = Date.now();
          const result = await deps.toolExecutor.execute(
            { toolCallId: tc.id, name: tc.name, arguments: tc.arguments },
            { sessionId: suspension.sessionId, turnId: suspension.turnId, pluginId: manifest.pluginId, runtimeId: manifest.name },
          );

          if (!result.success) {
            failedToolCalls.push({
              toolName: tc.name,
              message: extractToolFailureMessage(result.result),
            });
          }

          // Detect nested suspend — not supported, treat as error result
          if (process.env['COVEL_SUSPEND_V1'] === '1' && isSuspendSentinel(result.parsedResult)) {
            messages.push({
              role: 'tool',
              content: JSON.stringify({ error: 'Nested suspend is not supported' }),
              toolCallId: tc.id,
            });
            continue;
          }

          executedToolCalls.push({
            name: tc.name,
            arguments: tc.arguments,
            result: result.parsedResult,
            success: result.success,
          });

          let parsedInput: Record<string, unknown> = {};
          try { parsedInput = JSON.parse(tc.arguments) as Record<string, unknown>; } catch { /* keep empty */ }
          collectedToolCalls.push({
            toolCallId: tc.id,
            toolName: tc.name,
            pluginId: manifest.pluginId,
            runtimeId: manifest.name,
            turnId: suspension.turnId,
            input: parsedInput,
            output: result.parsedResult,
            durationMs: Date.now() - tcStart,
            approvalStatus: 'auto-allowed',
            timestamp: new Date().toISOString(),
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
      continue;
    }

    finalContent = response.content;
    stoppedWithResponse = true;
    break;
  }

  if (!stoppedWithResponse && !finalContent) {
    return {
      pluginId: manifest.pluginId,
      runtimeId: manifest.name,
      runId,
      turnId: suspension.turnId,
      status: 'failed',
      output: null,
      toolCalls: collectedToolCalls,
      durationMs: Date.now() - startTime,
      error: formatToolLoopFailure({
        runtimeId: manifest.name,
        reason: Date.now() >= deadline ? 'timeout' : 'max_steps',
        maxSteps,
        failedToolCalls,
      }),
      timestamp: new Date().toISOString(),
    };
  }

  // Parse final output
  let output: Record<string, unknown>;
  const presentableToolOutput = findPresentableToolOutput(executedToolCalls);
  const structuredToolOutput = findLastStructuredToolOutput(executedToolCalls);
  if (finalContent) {
    const parsed = parseFinalOutputEnvelope(finalContent);
    output = shouldSuppressToolLoopNarrative({
      outputKind: manifest.outputKind,
      executedToolCalls,
      parsedAsJson: parsed.parsedAsJson,
    })
      ? (structuredToolOutput ?? presentableToolOutput ?? { narrativeOutput: '' })
      : parsed.output;
  } else if (failedToolCalls.length > 0) {
    return {
      pluginId: manifest.pluginId,
      runtimeId: manifest.name,
      runId,
      turnId: suspension.turnId,
      status: 'failed',
      output: null,
      toolCalls: collectedToolCalls,
      durationMs: Date.now() - startTime,
      error: formatToolLoopFailure({
        runtimeId: manifest.name,
        reason: 'tool_failed_without_output',
        failedToolCalls,
      }),
      timestamp: new Date().toISOString(),
    };
  } else {
    output = presentableToolOutput ?? { narrativeOutput: '' };
  }

  const interactions: Array<Record<string, unknown>> = [];
  for (const tc of executedToolCalls) {
    if (!tc.success || !isRecord(tc.result)) continue;
    if (isRecord(tc.result.interaction)) {
      interactions.push(tc.result.interaction);
    }
  }

  if (interactions.length > 0) {
    output.interactions = interactions;
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

  if (manifest.outputKind === 'story' && typeof output.narrativeOutput === 'string') {
    output.narrativeOutput = sanitizeStoryNarrativeText(output.narrativeOutput);
  }

  // Mark suspension as resolved
  if (deps.store) {
    await deps.store.markSuspensionResolved(suspension.id);
  }

  // Emit turn.resumed event
  emitSubEvent(deps.eventBus, 'game', 'turn.resumed', suspension.sessionId, {
    sessionId: suspension.sessionId,
    turnId: suspension.turnId,
    suspensionId: suspension.id,
  });

  return {
    pluginId: manifest.pluginId,
    runtimeId: manifest.name,
    runId,
    turnId: suspension.turnId,
    status: 'success',
    output,
    toolCalls: collectedToolCalls,
    durationMs: Date.now() - startTime,
    timestamp: new Date().toISOString(),
  };
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
  defaultTimeoutMs: number,
  messageHistory: readonly TurnMessageRecord[],
  sessionMeta?: { turnNumber: number; phase: string; characters: readonly { name: string; type: string; description?: string; fields?: Record<string, unknown> }[]; lastFormValues?: Record<string, unknown> },
  hookPipeline?: HookPipeline,
  sessionSummaries?: readonly import('@covel/store').SessionSummaryRecord[],
  workingMemory?: readonly import('@covel/context').WorkingMemoryEntry[],
  coreMemoryBlocks?: readonly { label: string; content: string; updatedAt: string }[],
): Promise<RuntimeResult> {
  const startTime = Date.now();
  const runId = crypto.randomUUID();
  const timeoutMs = manifest.timeoutMs ?? defaultTimeoutMs;

  try {
    // Load the runtime (prompt template, references, handler, etc.)
    const loaded = await deps.loadRuntime(manifest, input.locale);
    if (!loaded) {
      return makeFailedResult(manifest, input, runId, startTime, 'Runtime not found');
    }

    // ── Function runtime: direct handler execution, no LLM ──────
    //
    // Function runtimes intentionally skip the PreRuntime hook: PreRuntime is
    // scoped as an "LLM execution gate" for agent runtimes, fired after the
    // optional guard passes and before the prompt assembly / LLM tool loop.
    // Function runtimes have no LLM pipeline to gate — a plugin that wants to
    // block a function runtime should use a `guard` in its PLUGIN.md instead.
    // PostRuntime DOES fire for function runtimes so observability stays
    // symmetric. See S4-T3 code review I2.
    if (manifest.runtimeType === 'function') {
      // Emit start for function runtimes (no guard to check)
      try {
        await deps.onRuntimeStart?.({
          runtimeId: manifest.name,
          pluginId: manifest.pluginId,
          priority: manifest.priority,
        });
      } catch { /* callback error must not kill runtime */ }
      emitSubEvent(deps.eventBus, 'runtime', 'runtime.started', input.sessionId, {
        runtimeId: manifest.name,
        pluginId: manifest.pluginId,
        priority: manifest.priority,
      });
      if (!loaded.handler) {
        return makeFailedResult(manifest, input, runId, startTime, 'Function runtime missing handler');
      }
      const config = deps.getConfig(manifest.pluginId, manifest.name);
      const output = await loaded.handler({
        sessionId: input.sessionId,
        turnId: input.turnId,
        pluginId: manifest.pluginId,
        playerMessage: input.playerMessage,
        locale: input.locale,
        store: deps.store,
        completedResults,
        config,
      });

      // ── Suspend detection for function runtimes (S4-T4) ────────────
      // If the handler returns { status: 'suspended', reason, resumeSchema } and
      // COVEL_SUSPEND_V1=1, persist a suspension and return status: 'suspended'.
      if (
        process.env['COVEL_SUSPEND_V1'] === '1' &&
        typeof output.status === 'string' &&
        output.status === 'suspended' &&
        typeof output.reason === 'string' &&
        deps.store
      ) {
        const suspensionId = crypto.randomUUID();
        const suspension: SuspensionRecord = {
          id: suspensionId,
          sessionId: input.sessionId,
          turnId: input.turnId,
          runtimeId: manifest.name,
          pluginId: manifest.pluginId,
          reason: output.reason as string,
          resumeSchema: output.resumeSchema ?? {},
          pendingContinuation: {
            messages: [],
            toolCallsSoFar: [],
            pendingProposals: [],
            // TODO(S4-T4.b): function runtime suspend carries no partial content
          },
          createdAt: new Date().toISOString(),
        };
        await deps.store.saveSuspension(suspension);

        emitSubEvent(deps.eventBus, 'game', 'turn.suspended', input.sessionId, {
          sessionId: input.sessionId,
          turnId: input.turnId,
          suspensionId,
          reason: suspension.reason,
          resumeSchema: suspension.resumeSchema,
        });

        const suspendedResult: RuntimeResult = {
          pluginId: manifest.pluginId,
          runtimeId: manifest.name,
          runId,
          turnId: input.turnId,
          status: 'suspended',
          output: {
            suspended: true,
            suspensionId,
            reason: suspension.reason,
            resumeSchema: suspension.resumeSchema,
          },
          toolCalls: [],
          durationMs: Date.now() - startTime,
          timestamp: new Date().toISOString(),
        };

        try {
          await deps.onRuntimeComplete?.({
            runtimeId: manifest.name,
            pluginId: manifest.pluginId,
            status: 'suspended',
            durationMs: suspendedResult.durationMs,
          });
        } catch { /* callback error must not kill runtime */ }

        emitSubEvent(deps.eventBus, 'runtime', 'runtime.completed', input.sessionId, {
          runtimeId: manifest.name,
          pluginId: manifest.pluginId,
          status: 'suspended',
          durationMs: suspendedResult.durationMs,
        });

        return runPostRuntimeHook(
          { pipeline: hookPipeline, sessionId: input.sessionId, turnId: input.turnId, pluginId: manifest.pluginId, runtimeId: manifest.name, eventBus: deps.eventBus },
          suspendedResult,
        );
      }

      const result: RuntimeResult = {
        pluginId: manifest.pluginId,
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
          sourcePluginId: manifest.pluginId,
          sourceRuntimeId: manifest.name,
          role: 'assistant',
          name: manifest.name,
          content: narrativeContent,
          order: manifest.priority,
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
      } catch { /* callback error must not kill runtime */ }

      emitSubEvent(deps.eventBus, 'runtime', 'runtime.completed', input.sessionId, {
        runtimeId: manifest.name,
        pluginId: manifest.pluginId,
        status: result.status,
        durationMs: result.durationMs,
      });

      // PostRuntime hook — function runtime path (S4-T3)
      return runPostRuntimeHook(
        { pipeline: hookPipeline, sessionId: input.sessionId, turnId: input.turnId, pluginId: manifest.pluginId, runtimeId: manifest.name, eventBus: deps.eventBus },
        result,
      );
    }

    // ── Guard: pre-execution gate for agent runtimes ────────────
    if (loaded.guard) {
      const guardConfig = deps.getConfig(manifest.pluginId, manifest.name);
      const guardOutput = await loaded.guard({
        sessionId: input.sessionId,
        turnId: input.turnId,
        pluginId: manifest.pluginId,
        playerMessage: input.playerMessage,
        locale: input.locale,
        store: deps.store,
        completedResults,
        config: guardConfig,
      });

      if (guardOutput.skip === true) {
        const result: RuntimeResult = {
          pluginId: manifest.pluginId,
          runtimeId: manifest.name,
          runId,
          turnId: input.turnId,
          status: 'success',
          output: guardOutput,
          toolCalls: [],
          durationMs: Date.now() - startTime,
          timestamp: new Date().toISOString(),
        };

        if (deps.store && typeof guardOutput.narrativeOutput === 'string' && guardOutput.narrativeOutput) {
          await deps.store.appendTurnMessage({
            id: crypto.randomUUID(),
            sessionId: input.sessionId,
            turnId: input.turnId,
            sourceType: 'runtime',
            sourcePluginId: manifest.pluginId,
            sourceRuntimeId: manifest.name,
            role: 'assistant',
            name: manifest.name,
            content: guardOutput.narrativeOutput as string,
            order: manifest.priority,
            createdAt: new Date().toISOString(),
          });
        }

        // Guard skipped: emit completed (without ever emitting started) so frontend
        // shows "skipped" instead of an infinite spinner.
        try {
          await deps.onRuntimeComplete?.({
            runtimeId: manifest.name,
            pluginId: manifest.pluginId,
            status: 'skipped',
            durationMs: result.durationMs,
          });
        } catch { /* callback error must not kill runtime */ }

        emitSubEvent(deps.eventBus, 'runtime', 'runtime.completed', input.sessionId, {
          runtimeId: manifest.name,
          pluginId: manifest.pluginId,
          status: 'skipped',
          durationMs: result.durationMs,
        });

        // PostRuntime hook — guard-skipped path (S4-T3)
        return runPostRuntimeHook(
          { pipeline: hookPipeline, sessionId: input.sessionId, turnId: input.turnId, pluginId: manifest.pluginId, runtimeId: manifest.name, eventBus: deps.eventBus },
          result,
        );
      }
    }

    // ── Agent runtime: LLM pipeline ─────────────────────────────
    // Emit start AFTER guard passes (or no guard exists) — prevents
    // frontend showing an infinite spinner for guard-skipped runtimes.
    try {
      await deps.onRuntimeStart?.({
        runtimeId: manifest.name,
        pluginId: manifest.pluginId,
        priority: manifest.priority,
      });
    } catch { /* callback error must not kill runtime */ }
    emitSubEvent(deps.eventBus, 'runtime', 'runtime.started', input.sessionId, {
      runtimeId: manifest.name,
      pluginId: manifest.pluginId,
      priority: manifest.priority,
    });

    // ── PreRuntime hook (S4-T3) ──────────────────────────────────
    {
      const preRtResult = await runPreRuntimeHook(
        { pipeline: hookPipeline, sessionId: input.sessionId, turnId: input.turnId, manifest, input, eventBus: deps.eventBus },
      );
      if (preRtResult.action === 'abort') {
        return {
          pluginId: manifest.pluginId,
          runtimeId: manifest.name,
          runId,
          turnId: input.turnId,
          status: 'skipped',
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
    if (manifest.outputKind === 'story') {
      // Build a set of runtimeIds whose outputKind is NOT 'story' (plugin/system outputs)
      const nonStoryRuntimeIds = new Set<string>();
      for (const rt of completedResults.keys()) {
        // completedResults only has current turn's runtimes; we also need
        // historical ones. Use a broader check: any sourceRuntimeId that
        // matches a known non-story runtime should be filtered.
      }
      // Simpler approach: only keep messages where:
      // - sourceType is player/system (user messages, system messages)
      // - sourceType is runtime AND sourceRuntimeId matches THIS runtime (own history)
      // - sourceType is runtime AND the message looks like narrative text (not JSON)
      filteredHistory = messageHistory.filter((m) => {
        if (m.sourceType === 'player' || m.sourceType === 'system') return true;
        if (m.sourceType === 'runtime') {
          // Keep own previous outputs
          if (m.sourceRuntimeId === manifest.name) return true;
          // Filter out messages that look like structured tool output (JSON objects)
          const content = m.content?.trim() ?? '';
          if (content.startsWith('{') || content.startsWith('[')) return false;
          // Keep narrative-like text from other runtimes
          return true;
        }
        return true;
      });
    }

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
      ...(budgetEligible
        ? { estimator: deps.estimator, contextBudget: deps.contextBudget }
        : {}),
    } as const;

    const assembled = needsAsyncBuild({ manifest })
      ? await buildContextAsync({ ...buildParams, store: deps.store })
      : buildContext(buildParams);

    // Build LLM messages
    const messages: LLMMessage[] = [
      { role: 'system', content: assembled.systemPrompt },
      ...assembled.messages,
    ];

    // LLM call with tool-calling loop
    let finalContent: string | null = null;
    const collectedToolCalls: ToolCallRecord[] = [];
    const executedToolCalls: ExecutedToolCallState[] = [];
    const failedToolCalls: FailedToolCallState[] = [];
    let steps = 0;

    const deadline = Date.now() + timeoutMs;
    let stoppedWithResponse = false;

    // Build tool definitions from manifest declarations (computed once, reused across steps)
    const toolDefs = deps.toolExecutor ? buildToolDefinitions(manifest, deps.toolExecutor) : undefined;
    // PR-6: per-session per-runtime slot override snapshot. Applies to all
    // runtime kinds (story + plugin), unlike the legacy story-only API
    // override below.
    const sessionRuntimeSlot = input.runtimeModelOverrides?.[manifest.name];
    const runtimeModelOverride =
      input.modelOverride && manifest.outputKind === 'story'
        ? input.modelOverride
        : sessionRuntimeSlot;

    // Stream only for story-output runtimes. Plugin runtimes' raw LLM text is
    // reasoning chatter that feeds into structured tool calls — it should never
    // reach the user's narrative feed. Story runtimes that also declare tools
    // (e.g. narrator + world-dimension-get) still stream: tool_call deltas are
    // accumulated from the stream alongside text deltas, and if the provider
    // cannot parse tool calls from stream chunks the loop falls back to
    // generate() when finishReason === 'tool_calls' with an empty accumulator.
    const useStreaming = !!(
      deps.onDelta &&
      deps.llm.stream &&
      manifest.outputKind === 'story'
    );

    // Per-runtime maxSteps override. Plugins that should call a tool once and
    // stop (e.g. core-guide) set `maxSteps: 2` in their frontmatter to prevent
    // the LLM from running the same tool in a loop after it already succeeds.
    const effectiveMaxSteps = manifest.maxSteps ?? maxSteps;

    while (steps < effectiveMaxSteps && Date.now() < deadline) {
      steps++;

      // Model resolution chain for story runtimes:
      // API override > plugin llm.toml > manifest.model > undefined.
      // Tool-heavy plugin runtimes stay on their declared slot so E2E story
      // overrides do not destabilize function-calling behaviour.
      const effectiveModel = deps.resolveModel
        ? deps.resolveModel(manifest, runtimeModelOverride)
        : (runtimeModelOverride ?? manifest.model);

      let response: import('./llm-adapter.js').LLMResponse;

      if (useStreaming) {
        // Streaming path: accumulate text + tool-call deltas, forward text to caller.
        let streamedContent = '';
        let streamFinishReason = 'stop';
        const streamedToolCalls: Array<{ id: string; name: string; arguments: string }> = [];
        // S1-T3: When the stream throws with no content we fall back to a
        // non-stream generate() call. Holding the fallback response here
        // (vs assigning `response` directly) keeps TypeScript's definite-
        // assignment analysis happy — `response` is set exactly once, below.
        let fallbackResponse: import('./llm-adapter.js').LLMResponse | null = null;

        // S1-T3: Wrap the stream loop. On exception mid-stream, either salvage
        // the accumulated content (if any) or fall back to a single non-stream
        // generate() call. Do not attempt prefix-continuation — no provider
        // offers a reliable cross-vendor protocol for it.
        try {
          for await (const event of deps.llm.stream!({
            model: effectiveModel,
            messages,
            tools: toolDefs,
          })) {
            if (event.type === 'text-delta') {
              streamedContent += event.textDelta;
              // M1: Wrap onDelta — client disconnect should not kill the runtime
              try {
                await deps.onDelta!({
                  runtimeId: manifest.name,
                  pluginId: manifest.pluginId,
                  textDelta: event.textDelta,
                });
              } catch {
                // Client disconnected — continue streaming to collect full content
              }
            } else if (event.type === 'tool-call') {
              streamedToolCalls.push({
                id: event.id,
                name: event.name,
                arguments: event.arguments,
              });
            } else if (event.type === 'done') {
              streamFinishReason = event.finishReason;
            }
          }
        } catch (streamError: unknown) {
          const errMsg = streamError instanceof Error ? streamError.message : String(streamError);

          if (streamedContent.length > 0 || streamedToolCalls.length > 0) {
            // Salvage: keep what we have and mark the finishReason as 'error'.
            streamFinishReason = 'error';
            console.warn(
              `[stream-recovery] runtime ${manifest.name} stream failed after partial content; salvaging ${streamedContent.length} chars, ${streamedToolCalls.length} tool calls. error=${errMsg}`,
            );
          } else {
            // Nothing to salvage — fall back to a single non-stream call.
            // If THIS also throws, let it bubble up to the outer executeOneRuntime catch.
            console.warn(
              `[stream-recovery] runtime ${manifest.name} stream failed before any content; falling back to generate(). error=${errMsg}`,
            );
            fallbackResponse = await deps.llm.generate({
              model: effectiveModel,
              messages,
              tools: toolDefs,
            });
          }
        }

        // If the stream finished with tool_calls but our adapter couldn't parse
        // them from the SSE chunks (some providers don't deliver tool_calls
        // inside delta), fall back to generate() to get the structured call.
        if (
          fallbackResponse === null &&
          streamFinishReason === 'tool_calls' &&
          streamedToolCalls.length === 0 &&
          toolDefs
        ) {
          fallbackResponse = await deps.llm.generate({
            model: effectiveModel,
            messages,
            tools: toolDefs,
          });
        }

        if (fallbackResponse !== null) {
          response = fallbackResponse;
        } else {
          response = {
            content: streamedContent || null,
            toolCalls: streamedToolCalls,
            finishReason: streamFinishReason as 'stop' | 'tool_calls' | 'length' | 'error',
            // M5: Streaming responses don't carry token usage from most providers.
            // The LLMStreamEvent 'done' type only has finishReason, not usage.
            usage: { inputTokens: 0, outputTokens: 0 },
          };
        }
      } else {
        // Non-streaming path: standard generate()
        try {
          response = await deps.llm.generate({
            model: effectiveModel,
            messages,
            tools: toolDefs,
          });
        } catch (error) {
          if (!toolDefs || !shouldRetryMalformedToolArguments(error)) {
            throw error;
          }
          response = await deps.llm.generate({
            model: effectiveModel,
            messages,
            tools: toolDefs,
          });
        }
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
            const tcStart = Date.now();

            // ── PreToolUse hook (S4-T3) ──────────────────────────
            const preToolOpts = { pipeline: hookPipeline, sessionId: input.sessionId, turnId: input.turnId, pluginId: manifest.pluginId, runtimeId: manifest.name, eventBus: deps.eventBus };
            const preToolOutcome = await runPreToolUseHook(preToolOpts, { id: tc.id, name: tc.name, arguments: tc.arguments });
            if (preToolOutcome.skipped) {
              // Skip tool execution; push synthetic tool-role message so LLM sees a result
              messages.push({
                role: 'tool',
                content: JSON.stringify({ error: `pre-tool-use hook aborted: ${preToolOutcome.reason}` }),
                toolCallId: tc.id,
              });
              continue;
            }

            // Use the (possibly replaced) toolCall from the hook outcome
            const effectiveTc = preToolOutcome.toolCall;

            const result = await deps.toolExecutor.execute(
              { toolCallId: effectiveTc.id, name: effectiveTc.name, arguments: effectiveTc.arguments },
              { sessionId: input.sessionId, turnId: input.turnId, pluginId: manifest.pluginId, runtimeId: manifest.name },
            );

            // ── PostToolUse hook (S4-T3) ─────────────────────────
            const toolResult = await runPostToolUseHook(preToolOpts, { id: effectiveTc.id, name: effectiveTc.name, arguments: effectiveTc.arguments }, result);

            if (!toolResult.success) {
              failedToolCalls.push({
                toolName: effectiveTc.name,
                message: extractToolFailureMessage(toolResult.result),
              });
            }

            // ── Suspend detection (S4-T4) ────────────────────────
            // When COVEL_SUSPEND_V1=1 and the suspend tool was called, capture
            // the current loop state and persist a SuspensionRecord. The tool
            // result is NOT pushed back to the LLM — instead we exit the loop
            // with status 'suspended'.
            if (
              process.env['COVEL_SUSPEND_V1'] === '1' &&
              isSuspendSentinel(toolResult.parsedResult) &&
              deps.store
            ) {
              const sentinel = toolResult.parsedResult;
              const suspensionId = crypto.randomUUID();

              // Messages array currently has the assistant message (with tool_calls)
              // but NOT the tool result for the suspend call. We capture the full
              // message array up to this point (including the assistant message).
              const pendingContinuation: SuspensionRecord['pendingContinuation'] = {
                messages: [...messages],
                partialContent: finalContent ?? undefined,
                toolCallsSoFar: [...collectedToolCalls],
                pendingProposals: [],
                // Store the suspend tool's call ID so resume can append a proper tool result
                suspendToolCallId: effectiveTc.id,
              };

              const suspension: SuspensionRecord = {
                id: suspensionId,
                sessionId: input.sessionId,
                turnId: input.turnId,
                runtimeId: manifest.name,
                pluginId: manifest.pluginId,
                reason: sentinel.reason,
                resumeSchema: sentinel.resumeSchema,
                pendingContinuation,
                createdAt: new Date().toISOString(),
              };

              await deps.store.saveSuspension(suspension);

              // Emit turn.suspended SSE event via the actions channel
              emitSubEvent(deps.eventBus, 'game', 'turn.suspended', input.sessionId, {
                sessionId: input.sessionId,
                turnId: input.turnId,
                suspensionId,
                reason: sentinel.reason,
                resumeSchema: sentinel.resumeSchema,
              });

              const suspendedResult: RuntimeResult = {
                pluginId: manifest.pluginId,
                runtimeId: manifest.name,
                runId,
                turnId: input.turnId,
                status: 'suspended',
                output: {
                  suspended: true,
                  suspensionId,
                  reason: sentinel.reason,
                  resumeSchema: sentinel.resumeSchema,
                },
                toolCalls: collectedToolCalls,
                durationMs: Date.now() - startTime,
                timestamp: new Date().toISOString(),
              };

              try {
                await deps.onRuntimeComplete?.({
                  runtimeId: manifest.name,
                  pluginId: manifest.pluginId,
                  status: 'suspended',
                  durationMs: suspendedResult.durationMs,
                });
              } catch { /* callback error must not kill runtime */ }

              emitSubEvent(deps.eventBus, 'runtime', 'runtime.completed', input.sessionId, {
                runtimeId: manifest.name,
                pluginId: manifest.pluginId,
                status: 'suspended',
                durationMs: suspendedResult.durationMs,
              });

              return runPostRuntimeHook(
                { pipeline: hookPipeline, sessionId: input.sessionId, turnId: input.turnId, pluginId: manifest.pluginId, runtimeId: manifest.name, eventBus: deps.eventBus },
                suspendedResult,
              );
            }

            executedToolCalls.push({
              name: effectiveTc.name,
              arguments: effectiveTc.arguments,
              result: toolResult.parsedResult,
              success: toolResult.success,
            });

            // Build ToolCallRecord for RuntimeResult.toolCalls
            let parsedInput: Record<string, unknown> = {};
            try { parsedInput = JSON.parse(effectiveTc.arguments) as Record<string, unknown>; } catch { /* keep empty */ }
            collectedToolCalls.push({
              toolCallId: effectiveTc.id,
              toolName: effectiveTc.name,
              pluginId: manifest.pluginId,
              runtimeId: manifest.name,
              turnId: input.turnId,
              input: parsedInput,
              output: toolResult.parsedResult,
              durationMs: Date.now() - tcStart,
              approvalStatus: toolResult.approvalStatus,
              timestamp: new Date().toISOString(),
            });

            messages.push({
              role: 'tool',
              content: toolResult.result,
              toolCallId: effectiveTc.id,
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
      stoppedWithResponse = true;
      break;
    }

    if (!stoppedWithResponse && !finalContent) {
      const result: RuntimeResult = {
        pluginId: manifest.pluginId,
        runtimeId: manifest.name,
        runId,
        turnId: input.turnId,
        status: 'failed',
        output: null,
        toolCalls: collectedToolCalls,
        durationMs: Date.now() - startTime,
        error: formatToolLoopFailure({
          runtimeId: manifest.name,
          reason: Date.now() >= deadline ? 'timeout' : 'max_steps',
          maxSteps: effectiveMaxSteps,
          failedToolCalls,
        }),
        timestamp: new Date().toISOString(),
      };

      return runPostRuntimeHook(
        { pipeline: hookPipeline, sessionId: input.sessionId, turnId: input.turnId, pluginId: manifest.pluginId, runtimeId: manifest.name, eventBus: deps.eventBus },
        result,
      );
    }

    // Build output from LLM final content + tool call results
    let output: Record<string, unknown>;
    const presentableToolOutput = findPresentableToolOutput(executedToolCalls);
    const structuredToolOutput = findLastStructuredToolOutput(executedToolCalls);
    if (finalContent) {
      const parsed = parseFinalOutputEnvelope(finalContent);
      output = shouldSuppressToolLoopNarrative({
        outputKind: manifest.outputKind,
        executedToolCalls,
        parsedAsJson: parsed.parsedAsJson,
      })
        ? (structuredToolOutput ?? presentableToolOutput ?? { narrativeOutput: '' })
        : parsed.output;
    } else if (failedToolCalls.length > 0) {
      const result: RuntimeResult = {
        pluginId: manifest.pluginId,
        runtimeId: manifest.name,
        runId,
        turnId: input.turnId,
        status: 'failed',
        output: null,
        toolCalls: collectedToolCalls,
        durationMs: Date.now() - startTime,
        error: formatToolLoopFailure({
          runtimeId: manifest.name,
          reason: 'tool_failed_without_output',
          failedToolCalls,
        }),
        timestamp: new Date().toISOString(),
      };

      return runPostRuntimeHook(
        { pipeline: hookPipeline, sessionId: input.sessionId, turnId: input.turnId, pluginId: manifest.pluginId, runtimeId: manifest.name, eventBus: deps.eventBus },
        result,
      );
    } else {
      output = presentableToolOutput ?? { narrativeOutput: '' };
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

    if (manifest.outputKind === 'story' && typeof output.narrativeOutput === 'string') {
      output.narrativeOutput = sanitizeStoryNarrativeText(output.narrativeOutput);
    }

    const result: RuntimeResult = {
      pluginId: manifest.pluginId,
      runtimeId: manifest.name,
      runId,
      turnId: input.turnId,
      status: 'success',
      output,
      toolCalls: collectedToolCalls,
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
        sourcePluginId: manifest.pluginId,
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

    try {
      await deps.onRuntimeComplete?.({
        runtimeId: manifest.name,
        pluginId: manifest.pluginId,
        status: result.status,
        durationMs: result.durationMs,
      });
    } catch { /* callback error must not kill runtime */ }

    emitSubEvent(deps.eventBus, 'runtime', 'runtime.completed', input.sessionId, {
      runtimeId: manifest.name,
      pluginId: manifest.pluginId,
      status: result.status,
      durationMs: result.durationMs,
    });

    // PostRuntime hook — agent success path (S4-T3)
    return runPostRuntimeHook(
      { pipeline: hookPipeline, sessionId: input.sessionId, turnId: input.turnId, pluginId: manifest.pluginId, runtimeId: manifest.name, eventBus: deps.eventBus },
      result,
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const failedResult = makeFailedResult(manifest, input, runId, startTime, message);
    await deps.onRuntimeComplete?.({
      runtimeId: manifest.name,
      pluginId: manifest.pluginId,
      status: failedResult.status,
      durationMs: failedResult.durationMs,
    });

    emitSubEvent(deps.eventBus, 'runtime', 'runtime.failed', input.sessionId, {
      runtimeId: manifest.name,
      pluginId: manifest.pluginId,
      status: failedResult.status,
      durationMs: failedResult.durationMs,
      error: message,
    });

    // PostRuntime hook — failure path (S4-T3)
    return runPostRuntimeHook(
      { pipeline: hookPipeline, sessionId: input.sessionId, turnId: input.turnId, pluginId: manifest.pluginId, runtimeId: manifest.name, eventBus: deps.eventBus },
      failedResult,
    );
  }
}

// buildToolDefinitions and makeFailedResult extracted to turn-executor-helpers.ts (S4-T3)
