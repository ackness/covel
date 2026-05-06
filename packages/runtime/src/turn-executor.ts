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
} from '@covel/shared';
import { isEnvEnabled } from '@covel/shared';
import type {
  AssetProgressInput,
  LoadedRuntime,
  PluginSource,
  PluginRuntimeGateway,
  PluginRuntimeUtils,
} from '@covel/plugin-loader';
import type {
  DataStore,
  TurnMessageRecord,
  SuspensionRecord,
  RuntimeOutputRecord,
} from '@covel/store';
import {
  isSuspendSentinel,
  isRuntimeDoneSentinel,
  validateOutput,
  withPendingProposals,
} from '@covel/tools';
import type { EventBus } from '@covel/events';
import { shouldTrigger } from './trigger.js';
import { isMainLoopPriority, isPreGamePriority, scheduleByPriority } from './scheduler.js';
import { scheduleByDag } from './dag-scheduler.js';
import {
  applyBranchReplyAcceptedCandidates,
  buildContext,
  buildContextAsync,
  buildSessionContextSnapshot,
  needsAsyncBuild,
} from '@covel/context';
import type {
  BudgetOptions,
  SessionContextSnapshot,
  TokenEstimator,
  CompactorRunner,
} from '@covel/context';
import { executeParallel } from './parallel-executor.js';
import type { TriggerContext, ScheduledGroup } from './types.js';
import type { LLMAdapter, LLMMessage } from './llm-adapter.js';
import type { ToolExecutor } from './tool-executor.js';
import type { HookPipeline } from './hooks/pipeline.js';
import { buildToolDefinitions, makeFailedResult, resolveUserSettings } from './turn-executor-helpers.js';
import {
  createPluginDataWriter,
  createPluginLogger,
  createFunctionStoreView,
} from './plugin-handler-helpers.js';
import {
  createRuntimeMediaContext,
  type MediaStoreLike,
} from './runtime-media-context.js';
import {
  buildRetryPolicy,
  callLLMWithRetry,
  streamLLMWithRetry,
  detectToolLoop,
  perturbMessages,
  LLMRetryError,
  type RetryInfo,
} from './llm-retry.js';
import {
  buildLlmCallingPayload,
  buildLlmRespondedErrorPayload,
  buildLlmRespondedSuccessPayload,
} from './llm-trace-payload.js';
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
  /**
   * Optional narrow gateway facade forwarded to function-runtime handlers
   * and guards via `FunctionHandlerContext.gateway`. Agent runtimes go
   * through `deps.llm` as before — this is purely for `runtimeType:
   * 'function'` handlers that want to call `generateImage` /
   * `generateObject` / `generateText` directly. Absent in test harnesses
   * that don't wire up the ai-provider gateway; handlers must null-check.
   */
  readonly gateway?: PluginRuntimeGateway;
  /**
   * Optional plugin-facing utility surface (SSRF guard + retrying fetch)
   * forwarded to function-runtime handlers via `FunctionHandlerContext.utils`.
   * Wired in production from `@covel/ai-provider/plugin-utils`. Absent in
   * test harnesses; handlers must null-check before use.
   */
  readonly utils?: PluginRuntimeUtils;
  /**
   * Optional MediaStore forwarded to function-runtime handlers as
   * `FunctionHandlerContext.media`. Store implementation is provided by
   * the P0-a MediaStore Core package.
   */
  readonly mediaStore?: MediaStoreLike;
  /**
   * Resolve trust from plugin discovery source. Registry/bootstrap wires this
   * from the directory a plugin was loaded from, which is stronger than the
   * author-supplied `pluginType` manifest field.
   */
  readonly getPluginSource?: (pluginId: string) => PluginSource | undefined;
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
  readonly onRuntimeStart?: (info: { runtimeId: string; pluginId: string; priority: number | undefined }) => Promise<void>;
  /** Called when a runtime completes execution. */
  readonly onRuntimeComplete?: (info: { runtimeId: string; pluginId: string; status: string; durationMs: number; error?: string }) => Promise<void>;

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
   * Optional hook pipeline. When present, lifecycle hooks fire at 8 points
   * during turn execution. When absent, all hook sites are pure no-ops —
   * identical to pre-hook behaviour. Plugin hooks are registered by
   * bootstrap; callers that build the executor directly (CLI tools, tests)
   * can pass `undefined` to keep the non-hook fast path.
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
      /** Optional — await any pending updateAfterTurn for the session. */
      awaitPending?(sessionId: string): Promise<void>;
    };
  };

  /**
   * Optional world data plugin ID (Sprint 1-D). Resolved by the server via
   * `pluginRegistry.findPluginByCapability(sessionId, 'world-data-provider')`
   * and passed down so `buildSessionContextSnapshot` can fetch the active
   * world's plugin_data (schema, dimensions, tone, opening scenario).
   *
   * Only consulted when `process.env.COVEL_SESSION_CONTEXT === '1'`. When the
   * flag is off or this field is absent, the legacy scattered-load code path
   * runs unchanged.
   */
  readonly worldDataPluginId?: string;

  /**
   * Trace emitter for per-turn observability. When present, runtime emits
   * tool.calling / tool.completed / llm.calling / llm.responded / message.completed
   * etc. into trace_events and the action SSE stream via eventBus.
   * Optional for backward compatibility with tests and embedders.
   */
  readonly emitter?: import('./turn-emitter.js').TurnEmitter;
}

export interface TurnExecutorOptions {
  /** Max LLM tool-calling loop steps per runtime. Default: 10. */
  readonly maxSteps?: number;
  /** Timeout per runtime in ms. Default: 60000. */
  readonly timeoutMs?: number;
  /** Default maximum nested ctx.recursiveCall() depth. Default: 10. */
  readonly maxRecursionDepth?: number;
  /** Internal current recursion depth. Top-level callers should omit it. */
  readonly recursionDepth?: number;
}

interface TurnInputExecutionFlags {
  readonly suppressPlayerMessage?: boolean;
}

export class MaxRecursionExceeded extends Error {
  readonly code = 'MAX_RECURSION_EXCEEDED' as const;
  readonly depth: number;
  readonly maxDepth: number;
  readonly runtimeId: string;

  constructor(args: { runtimeId: string; depth: number; maxDepth: number }) {
    super(`recursiveCall exceeded max depth ${args.maxDepth} for runtime "${args.runtimeId}"`);
    this.name = 'MaxRecursionExceeded';
    this.runtimeId = args.runtimeId;
    this.depth = args.depth;
    this.maxDepth = args.maxDepth;
  }
}

// ── Helpers ─────────────────────────────────────────────────────

/** Emit a subscription-style event via the EventBus (if present). */
/**
 * Heuristic: does `content` look like structured (non-narrative) runtime
 * output that the narrator should NOT ingest as prior prose? Covers:
 *
 *  - Raw JSON (starts with `{` or `[`)
 *  - Markdown-fenced JSON: ```` ```json ```` / ```` ```ts ```` / ```` ``` ````
 *    wrapping an object/array body
 *  - Bare backtick-wrapped bodies (codex EntryCard text dumps)
 *  - `<tool>`-prefixed transcripts that tool-using plugins occasionally log
 *
 * Any false positive here just reduces context the narrator sees — much
 * safer than leaking structured JSON into the prose stream and triggering
 * the narrator to mimic the schema.
 *
 * Exported for unit testing (see turn-executor-story-filter.test.ts).
 */
export function looksLikeStructuredRuntimeOutput(raw: string | undefined | null): boolean {
  if (!raw) return false;
  let s = raw.trim();
  if (s.length === 0) return false;

  // Strip one level of markdown fences (```json / ```ts / ```).
  const fence = s.match(/^```[\w-]*\s*([\s\S]*?)\s*```$/);
  if (fence && fence[1]) {
    s = fence[1].trim();
  }

  // Classic JSON opener.
  if (s.startsWith('{') || s.startsWith('[')) return true;

  // Bare backtick-wrapped body — codex/guide sometimes emit ``…`` with JSON
  // inside. Strip a single pair of backticks and recheck.
  if (s.startsWith('`') && s.endsWith('`')) {
    const inner = s.slice(1, -1).trim();
    if (inner.startsWith('{') || inner.startsWith('[')) return true;
  }

  // `<tool>` / `<tool-call>` transcript dumps.
  if (/^<tool[- >]/i.test(s)) return true;

  return false;
}

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

function isTrustedPluginSource(
  deps: TurnExecutorDeps,
  manifest: RuntimeManifest,
): boolean {
  const source = deps.getPluginSource?.(manifest.pluginId);
  if (source) return source === 'builtin' || source === 'official';
  return manifest.pluginType === 'core-plugin';
}

function createAssetProgressEmitter(
  emitter: TurnExecutorDeps['emitter'],
  identity: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly pluginId: string;
    readonly runtimeId: string;
  },
): ((progress: AssetProgressInput) => Promise<void>) | undefined {
  if (!emitter) return undefined;
  return async (progress) => {
    const phase = progress.phase.trim();
    if (phase.length === 0) {
      throw new Error('assetProgress.phase must be a non-empty string');
    }
    if (
      progress.percent !== undefined
      && (!Number.isFinite(progress.percent) || progress.percent < 0 || progress.percent > 100)
    ) {
      throw new Error('assetProgress.percent must be a number from 0 to 100');
    }

    await emitter.emit('asset.progress', {
      ...identity,
      ...(progress.assetId ? { assetId: progress.assetId } : {}),
      phase,
      ...(progress.percent === undefined ? {} : { percent: progress.percent }),
      ...(progress.message ? { message: progress.message } : {}),
      ...(progress.modality ? { modality: progress.modality } : {}),
      ...(progress.meta === undefined ? {} : { meta: progress.meta }),
    });
  };
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

/**
 * Test-only export. Used by `tests/parse-final-output-envelope.test.ts` to
 * exercise the lenient-fallback contract documented in the body. Production
 * callers stay inside this module.
 */
export function __testOnly_parseFinalOutputEnvelope(
  finalContent: string,
): ReturnType<typeof parseFinalOutputEnvelope> {
  return parseFinalOutputEnvelope(finalContent);
}

function parseFinalOutputEnvelope(finalContent: string): {
  readonly output: Record<string, unknown>;
  readonly parsedAsJson: boolean;
} {
  const stripped = finalContent.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
  // Fast path: the model obeyed and produced a clean JSON object.
  try {
    const direct = JSON.parse(stripped);
    if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
      return { output: direct as Record<string, unknown>, parsedAsJson: true };
    }
  } catch {
    // fall through to lenient extraction below
  }

  // Lenient path: the model violated the "pure JSON only" contract and
  // emitted prose followed by a trailing JSON envelope. This is the typical
  // failure mode of plugin runtimes that share a system prompt with the
  // narrator (the model's training nudges it to keep telling the story
  // before reaching the JSON envelope it was actually asked to output). If
  // the trailing object is the canonical envelope the runtime declared, we
  // would rather salvage it than drop the whole event chain — without this
  // fallback, e.g. an image-prompt runtime's `events[].topic` envelope is
  // lost, the follower runtime never fires, and any background gallery
  // silently stays empty for the player.
  const salvaged = extractLastBalancedJsonObject(stripped);
  if (salvaged) {
    return { output: salvaged, parsedAsJson: true };
  }

  return { output: { narrativeOutput: finalContent }, parsedAsJson: false };
}

/**
 * Find the last balanced JSON object embedded in `text` and parse it.
 *
 * Scans forward tracking brace depth and string state so braces inside JSON
 * string literals don't unbalance the count. Whenever depth returns to zero
 * the spanning slice is parsed; the latest successful parse wins. Returns
 * null when no balanced object parses cleanly.
 *
 * Restricted to plain objects (not arrays / primitives) because every plugin
 * runtime envelope this fallback exists for is an object — accepting arrays
 * would risk swallowing prose that happens to end in `[1,2,3]`.
 */
function extractLastBalancedJsonObject(text: string): Record<string, unknown> | null {
  let lastValid: Record<string, unknown> | null = null;
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      if (depth === 0) continue;
      depth--;
      if (depth === 0 && start >= 0) {
        const candidate = text.slice(start, i + 1);
        try {
          const parsed = JSON.parse(candidate);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            lastValid = parsed as Record<string, unknown>;
          }
        } catch {
          // not a complete JSON object yet — keep scanning
        }
        start = -1;
      }
    }
  }
  return lastValid;
}

/**
 * Pull the top-level `required: [...]` field names out of a JSON Schema so
 * the schema-validation failure path can surface them as a hint to the user.
 * Returns an empty array for malformed schemas — never throws.
 */
function extractRequiredFields(
  schema: Readonly<Record<string, unknown>>,
): readonly string[] {
  const required = schema.required;
  if (!Array.isArray(required)) return [];
  return required.filter((field): field is string => typeof field === 'string' && field.length > 0);
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

function isRequiredUpstreamSatisfied(upstream: RuntimeResult | undefined): boolean {
  if (!upstream) return false;
  if (upstream.status === 'success') return true;
  if (upstream.status !== 'skipped') return false;
  const output = upstream.output ?? {};
  return output.preGameDone === true || output.initialized === true;
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
  const recursionDepth = options?.recursionDepth ?? 0;
  const executionFlags = input as TurnInput & TurnInputExecutionFlags;
  const shouldAppendPlayerMessage = !input.manualTrigger
    && !executionFlags.suppressPlayerMessage
    && input.playerMessage.length > 0;

  // Emit turn.started — when a manual trigger drove this turn we tag the
  // event with the runtime + plugin id so observability surfaces (the
  // /debug page in particular) can distinguish a player-driven story turn
  // from an out-of-band plugin-rpc invocation that happens to share the
  // same event pipeline.
  emitSubEvent(deps.eventBus, 'game', 'turn.started', input.sessionId, {
    turnId: input.turnId,
    sessionId: input.sessionId,
    ...(input.manualTrigger
      ? {
          manualTrigger: {
            runtimeId: input.manualTrigger.runtimeId,
            ...(input.manualTrigger.runtimeId.includes('/')
              ? { pluginId: input.manualTrigger.runtimeId.split('/')[0] }
              : { pluginId: input.manualTrigger.runtimeId }),
          },
        }
      : {}),
  });

  // ── TurnStart hook (S4-T3) ───────────────────────────────────
  {
    const tsResult = await runTurnStartHook(
      { pipeline: deps.hookPipeline, sessionId: input.sessionId, turnId: input.turnId, eventBus: deps.eventBus, emitter: deps.emitter },
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
  const turnNumber = messageHistory.filter((m) => m.sourceType === 'player').length;

  // Save player message to the append-only history.
  // Skip for manual-trigger turns — plugin-rpc invocations are not player
  // chat messages and must not pollute history or bump turnsSinceLastTrigger.
  if (deps.store && shouldAppendPlayerMessage) {
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
    // the last runtime message, blocking plugins like guide on every
    // subsequent turn.
    messageHistory = await deps.store.listTurnMessages(input.sessionId);
  }

  // 0b. Compaction (S2-T2): run before buildContext so summaries are stored
  //     before the turn's context assembly reads them.
  //     Only runs when COVEL_COMPACTOR_V1=1 AND a compactor is injected.
  //     Skipped for manual triggers — they don't add player messages, so
  //     there's nothing new to compact.
  if (isEnvEnabled('COVEL_COMPACTOR_V1') && deps.compactor && deps.store && shouldAppendPlayerMessage) {
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
  // Key by sourceRuntimeId (e.g. "world-init/schema-gen") to match rt.name used in lookup,
  // since sourcePluginId stores the plugin package ID (e.g. "world-init") which differs for
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

  // Load session metadata for context injection (turnNumber, characters, lastFormValues, status, preGameCompleted).
  let sessionStatus: 'active' | 'paused' | 'ended' = 'active';
  let preGameCompleted: readonly string[] = [];
  let sessionCharacters: { name: string; type: string; description?: string; fields?: Record<string, unknown> }[] = [];
  let lastFormValues: Record<string, unknown> | undefined;
  if (deps.store) {
    const session = await deps.store.getSession(input.sessionId);
    if (session) {
      sessionStatus = session.status;
      preGameCompleted = session.preGameCompleted ?? [];
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
  // Abort early if session is paused or ended — no runtimes should execute.
  if (sessionStatus !== 'active') {
    return {
      turnId: input.turnId,
      sessionId: input.sessionId,
      runtimeResults: [],
      durationMs: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    };
  }
  let sessionMeta = { turnNumber, characters: sessionCharacters, lastFormValues, preGameCompleted };
  const promptHistory = messageHistory.filter(
    (msg) => !(msg.turnId === input.turnId && msg.sourceType === 'player'),
  );
  let projectedPromptHistory: readonly TurnMessageRecord[] = promptHistory;
  if (deps.store) {
    try {
      const branchReplyTurns = await deps.store.listPluginData(input.sessionId, 'branch-reply', 'turns');
      projectedPromptHistory = applyBranchReplyAcceptedCandidates(promptHistory, branchReplyTurns);
    } catch {
      projectedPromptHistory = promptHistory;
    }
  }
  const preGameRuntimes = activeRuntimes.filter(
    (rt) => rt.priority !== undefined && rt.priority <= 99,
  );
  const isPreGamePending = preGameRuntimes.some((rt) => !preGameCompleted.includes(rt.name));

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
        if (m.sourceType === 'runtime' && m.sourceRuntimeId === rt.name) {
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
    groups = [{
      priority: manualTarget.priority ?? 500,
      runtimes: [manualTarget],
    }];
  } else if (isPreGamePending) {
    const preGameTriggered = triggered.filter((rt) => isPreGamePriority(rt.priority));
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
  let sessionSummaries: import('@covel/store').SessionSummaryRecord[] = [];
  if (isEnvEnabled('COVEL_COMPACTOR_V1') && deps.store) {
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
  if (isEnvEnabled('COVEL_MEMORY_V1') && deps.memorySystem) {
    try {
      await deps.memorySystem.manager.initializeDefaults(input.sessionId);
      coreMemoryBlocks = await deps.memorySystem.manager.loadBlocks(input.sessionId);
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
    if (!isEnvEnabled('COVEL_SESSION_CONTEXT') || !deps.store) return;
    try {
      const sessionRecord = await deps.store.getSession(input.sessionId);
      sessionContext = await buildSessionContextSnapshot(deps.store, input.sessionId, {
        locale: input.locale ?? 'zh-CN',
        turnNumber,
        worldId: sessionRecord?.worldId ?? undefined,
        worldDataPluginId: deps.worldDataPluginId,
        coreMemoryBlocks,
        summaries: sessionSummaries,
        playerMessage: input.playerMessage,
      });
    } catch (err) {
      // Non-critical: snapshot build failures must not abort the turn.
      // Legacy scattered reads above still cover every downstream consumer.
      console.warn(
        '[turn-executor] SessionContextSnapshot build failed, falling back to legacy reads:',
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
      if (typeof topic !== 'string' || topic.length === 0) continue;
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
      const guardSkipped = result.status === 'skipped' && output?.skip === true;
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
      if (max !== undefined && (runtimeTriggerCounts.get(rt.name) ?? 0) >= max) {
        newlyDone.push(rt.name);
      }
    }

    const updated = newlyDone.length > 0
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
      const refreshedCharacters = await deps.store.listCharacters(input.sessionId);
      sessionMeta = {
        ...sessionMeta,
        preGameCompleted,
        characters: refreshedCharacters.map(c => ({
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
        manualTarget && manualTriggerEventPayload && manifest.name === manualTarget.name
          ? manualTriggerEventPayload
          : undefined;
      return executeOneRuntime(manifest, input, activeRuntimes, completedResults, deps, maxSteps, defaultTimeoutMs, projectedPromptHistory, sessionMeta, deps.hookPipeline, sessionSummaries, workingMemory, coreMemoryBlocks, sessionContext, triggerEventForRuntime, options, recursionDepth);
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
    const followupGroups = dag.error ? scheduleByPriority(mainLoop, turnNumber) : dag.groups;
    for (const group of followupGroups) {
      const results = await executeParallel(group.runtimes, async (manifest) => {
        return executeOneRuntime(manifest, input, activeRuntimes, completedResults, deps, maxSteps, defaultTimeoutMs, projectedPromptHistory, sessionMeta, deps.hookPipeline, sessionSummaries, workingMemory, coreMemoryBlocks, sessionContext, undefined, options, recursionDepth);
      });
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
      if (rt.trigger?.type !== 'event') return false;
      return rt.trigger.topic !== undefined && emittedEvents.has(rt.trigger.topic);
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
      const matchedEvent = topic !== undefined ? currentDepthEvents.get(topic) : undefined;
      if (manifest.execution === 'background' && topic !== undefined && matchedEvent !== undefined) {
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
      const matchedEvent = topic !== undefined ? currentDepthEvents.get(topic) : undefined;
      const triggerEvent = topic !== undefined && matchedEvent !== undefined
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
          buildRuntimeOutputFromResult(
            rr,
            input.sessionId,
            turnNumber,
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
    if (isEnvEnabled('COVEL_SNAPSHOTS_V1')) {
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
  if (isEnvEnabled('COVEL_MEMORY_V1') && deps.memorySystem && coreMemoryBlocks.length > 0) {
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
    { pipeline: deps.hookPipeline, sessionId: input.sessionId, turnId: input.turnId, eventBus: deps.eventBus, emitter: deps.emitter },
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

  const hookPipeline = deps.hookPipeline;

  // ── PreRuntime hook (audit 2026-04-20 finding 6) ───────────────
  // Mirror the main pipeline's PreRuntime/PostRuntime pair so hook-driven
  // plugins (audit logs, metrics, cache warmers) see a symmetric resume.
  // `TurnStart` / `TurnStop` are intentionally NOT re-emitted: resume is a
  // continuation of an existing turn, not a new one.
  //
  // We build a synthetic TurnInput from the suspension so PreRuntime hooks
  // that inspect sessionId/turnId/manifest still function. `playerMessage`
  // is empty because resume data is delivered as a tool result below, not
  // as a new user message.
  const resumeTurnInput = {
    sessionId: suspension.sessionId,
    turnId: suspension.turnId,
    playerMessage: '',
  };
  if (hookPipeline) {
    const preRtResult = await runPreRuntimeHook(
      {
        pipeline: hookPipeline,
        sessionId: suspension.sessionId,
        turnId: suspension.turnId,
        manifest,
        input: resumeTurnInput as unknown as TurnInput,
        eventBus: deps.eventBus,
        emitter: deps.emitter,
      },
    );
    if (preRtResult.action === 'abort') {
      const abortedResult: RuntimeResult = {
        pluginId: manifest.pluginId,
        runtimeId: manifest.name,
        runId,
        turnId: suspension.turnId,
        status: 'skipped',
        output: null,
        toolCalls: [],
        durationMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      };
      return runPostRuntimeHook(
        {
          pipeline: hookPipeline,
          sessionId: suspension.sessionId,
          turnId: suspension.turnId,
          pluginId: manifest.pluginId,
          runtimeId: manifest.name,
          eventBus: deps.eventBus,
          emitter: deps.emitter,
        },
        abortedResult,
      );
    }
  }

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

  // Shared PostRuntime wrapper for every exit point (audit finding 6).
  const finalizeWithPostRuntime = (result: RuntimeResult): RuntimeResult | Promise<RuntimeResult> =>
    hookPipeline
      ? runPostRuntimeHook(
        {
          pipeline: hookPipeline,
          sessionId: suspension.sessionId,
          turnId: suspension.turnId,
          pluginId: manifest.pluginId,
          runtimeId: manifest.name,
          eventBus: deps.eventBus,
          emitter: deps.emitter,
        },
        result,
      )
      : result;

  // Load the runtime to get toolDefs etc.
  const loaded = await deps.loadRuntime(manifest, undefined);
  if (!loaded) {
    return finalizeWithPostRuntime({
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
    });
  }

  const collectedToolCalls: ToolCallRecord[] = [...(pendingContinuation.toolCallsSoFar as ToolCallRecord[])];
  const executedToolCalls: ExecutedToolCallState[] = [];
  const failedToolCalls: FailedToolCallState[] = [];
  const pendingProposals: Proposal[] = [...(pendingContinuation.pendingProposals as Proposal[])];
  let finalContent: string | null = pendingContinuation.partialContent ?? null;
  let steps = 0;
  const deadline = Date.now() + timeoutMs;
  let stoppedWithResponse = false;

  const toolContext = {
    sessionId: suspension.sessionId,
    turnId: suspension.turnId,
    pluginId: manifest.pluginId,
    runtimeId: manifest.name,
  } as const;
  const toolDefs = deps.toolExecutor
    ? buildToolDefinitions(manifest, deps.toolExecutor, toolContext)
    : undefined;

  while (steps < maxSteps && Date.now() < deadline) {
    steps++;

    const effectiveModel = deps.resolveModel
      ? deps.resolveModel(manifest, undefined)
      : manifest.model;

    const llmCallStart = Date.now();
    if (deps.emitter) {
      // Direct generate path (resume): provider is not plumbed here because
      // the retry helper — which owns provider identification — is bypassed.
      // Explicit `null` signals "provider unknown at this call site" and
      // survives JSON serialisation (unlike `undefined`, which `JSON.stringify`
      // drops), so downstream consumers see a stable key across all sites.
      await deps.emitter.emit('llm.calling', buildLlmCallingPayload({
        runtimeId: manifest.name,
        pluginId: manifest.pluginId,
        slot: effectiveModel,
        model: effectiveModel,
        provider: null,
        messages,
        tools: toolDefs,
        attempt: 0,
      }));
    }
    let response;
    try {
      response = await deps.llm.generate({
        model: effectiveModel,
        messages,
        tools: toolDefs,
        // Without this signal a hung provider HTTP call blocks forever — the
        // while-loop deadline only gates between iterations. Using remaining
        // budget keeps each LLM call bounded by the runtime's overall timeout.
        signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now())),
      });
    } catch (err) {
      // Pair every `llm.calling` with an `llm.responded` on the error path so
      // trace-viewer pairing stays intact when the direct generate throws.
      if (deps.emitter) {
        await deps.emitter.emit('llm.responded', buildLlmRespondedErrorPayload({
          runtimeId: manifest.name,
          pluginId: manifest.pluginId,
          error: err,
          durationMs: Date.now() - llmCallStart,
          attempt: 0,
        }));
      }
      throw err;
    }
    if (deps.emitter) {
      await deps.emitter.emit('llm.responded', buildLlmRespondedSuccessPayload({
        runtimeId: manifest.name,
        pluginId: manifest.pluginId,
        response,
        durationMs: Date.now() - llmCallStart,
        attempt: 0,
      }));
    }

    if (response.toolCalls.length > 0) {
      if (response.content) finalContent = response.content;

      messages.push({
        role: 'assistant',
        content: response.content ?? '',
        toolCalls: response.toolCalls,
        ...(response.reasoningContent ? { reasoningContent: response.reasoningContent } : {}),
      });

      for (const tc of response.toolCalls) {
        if (deps.toolExecutor) {
          const tcStart = Date.now();

          // ── PreToolUse hook (audit 2026-04-20 finding 6) ────────
          // Without this, pre-tool-use hooks that gate destructive tools
          // (e.g. "ask for approval") are NOT consulted on resume — which
          // would let a tool that was blocked pre-suspend run unchecked
          // after the suspend boundary.
          const preToolOpts = {
            pipeline: hookPipeline,
            sessionId: suspension.sessionId,
            turnId: suspension.turnId,
            pluginId: manifest.pluginId,
            runtimeId: manifest.name,
            eventBus: deps.eventBus,
            emitter: deps.emitter,
          };
          const preToolOutcome = await runPreToolUseHook(
            preToolOpts,
            { id: tc.id, name: tc.name, arguments: tc.arguments },
          );
          if (preToolOutcome.skipped) {
            messages.push({
              role: 'tool',
              content: JSON.stringify({ error: `pre-tool-use hook aborted: ${preToolOutcome.reason}` }),
              toolCallId: tc.id,
            });
            continue;
          }
          const effectiveTc = preToolOutcome.toolCall;

          const rawResult = await deps.toolExecutor.execute(
            { toolCallId: effectiveTc.id, name: effectiveTc.name, arguments: effectiveTc.arguments },
            {
              sessionId: suspension.sessionId,
              turnId: suspension.turnId,
              pluginId: manifest.pluginId,
              runtimeId: manifest.name,
              pendingProposals: pendingProposals,
              emitter: deps.emitter,
            },
          );

          // PostToolUse hook
          const result = await runPostToolUseHook(
            preToolOpts,
            { id: effectiveTc.id, name: effectiveTc.name, arguments: effectiveTc.arguments },
            rawResult,
          );

          if (!result.success) {
            failedToolCalls.push({
              toolName: effectiveTc.name,
              message: extractToolFailureMessage(result.result),
            });
          }

          if (result.pendingProposals && result.pendingProposals.length > 0) {
            pendingProposals.push(...result.pendingProposals);
          }

          // Detect nested suspend — not supported, treat as error result
          if (isEnvEnabled('COVEL_SUSPEND_V1') && isSuspendSentinel(result.parsedResult)) {
            messages.push({
              role: 'tool',
              content: JSON.stringify({ error: 'Nested suspend is not supported' }),
              toolCallId: effectiveTc.id,
            });
            continue;
          }

          executedToolCalls.push({
            name: effectiveTc.name,
            arguments: effectiveTc.arguments,
            result: result.parsedResult,
            success: result.success,
          });

          let parsedInput: Record<string, unknown> = {};
          try { parsedInput = JSON.parse(effectiveTc.arguments) as Record<string, unknown>; } catch { /* keep empty */ }
          collectedToolCalls.push({
            toolCallId: effectiveTc.id,
            toolName: effectiveTc.name,
            pluginId: manifest.pluginId,
            runtimeId: manifest.name,
            turnId: suspension.turnId,
            input: parsedInput,
            output: result.parsedResult,
            durationMs: Date.now() - tcStart,
            approvalStatus: result.approvalStatus ?? 'auto-allowed',
            timestamp: new Date().toISOString(),
          });

          messages.push({
            role: 'tool',
            content: result.result,
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
      continue;
    }

    finalContent = response.content;
    stoppedWithResponse = true;
    break;
  }

  if (!stoppedWithResponse && !finalContent) {
    return finalizeWithPostRuntime({
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
    });
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
    return finalizeWithPostRuntime({
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
    });
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

  if (pendingProposals.length > 0) {
    output = withPendingProposals(output, pendingProposals) as Record<string, unknown>;
  }

  // Mark suspension as resolved
  if (deps.store) {
    await deps.store.markSuspensionResolved(suspension.id);
  }

  // Emit turn.resumed event. Include pluginId/runtimeId so web clients can
  // also use this payload to stamp execution-timeline chips as resolved
  // without needing to cross-reference the original suspension record.
  emitSubEvent(deps.eventBus, 'game', 'turn.resumed', suspension.sessionId, {
    sessionId: suspension.sessionId,
    turnId: suspension.turnId,
    suspensionId: suspension.id,
    pluginId: manifest.pluginId,
    runtimeId: manifest.name,
  });

  return finalizeWithPostRuntime({
    pluginId: manifest.pluginId,
    runtimeId: manifest.name,
    runId,
    turnId: suspension.turnId,
    status: 'success',
    output,
    toolCalls: collectedToolCalls,
    durationMs: Date.now() - startTime,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Execute a single runtime. Dispatches to function handler or LLM agent pipeline
 * based on `manifest.runtimeType`.
 */
async function executeOneRuntime(
  manifest: RuntimeManifest,
  input: TurnInput,
  activeRuntimes: readonly RuntimeManifest[],
  completedResults: ReadonlyMap<string, RuntimeResult>,
  deps: TurnExecutorDeps,
  maxSteps: number,
  defaultTimeoutMs: number,
  messageHistory: readonly TurnMessageRecord[],
  sessionMeta?: {
    turnNumber: number;
    characters: readonly { name: string; type: string; description?: string; fields?: Record<string, unknown> }[];
    lastFormValues?: Record<string, unknown>;
    preGameCompleted?: readonly string[];
  },
  hookPipeline?: HookPipeline,
  sessionSummaries?: readonly import('@covel/store').SessionSummaryRecord[],
  workingMemory?: readonly import('@covel/context').WorkingMemoryEntry[],
  coreMemoryBlocks?: readonly { label: string; content: string; updatedAt: string }[],
  sessionContext?: SessionContextSnapshot,
  triggerEvent?: { readonly topic: string; readonly data: Readonly<Record<string, unknown>> },
  turnOptions?: TurnExecutorOptions,
  recursionDepth = 0,
): Promise<RuntimeResult> {
  const startTime = Date.now();
  const runId = crypto.randomUUID();
  const timeoutMs = manifest.timeoutMs ?? defaultTimeoutMs;
  const createRecursiveCall = () => {
    return async (
      delta: Partial<TurnInput>,
      opts?: { readonly reason?: string },
    ): Promise<TurnResult> => {
      const maxDepth = manifest.maxRecursionDepth ?? turnOptions?.maxRecursionDepth ?? 10;
      const nextDepth = recursionDepth + 1;
      const reason = typeof opts?.reason === 'string' && opts.reason.length > 0 ? opts.reason : undefined;

      const nestedInput: TurnInput & TurnInputExecutionFlags = {
        ...input,
        ...delta,
        sessionId: delta.sessionId ?? input.sessionId,
        turnId: delta.turnId ?? input.turnId,
        playerMessage: delta.playerMessage ?? input.playerMessage,
        suppressPlayerMessage: true,
      };

      const tracePayload = {
        runtimeId: manifest.name,
        pluginId: manifest.pluginId,
        depth: recursionDepth,
        nextDepth,
        maxDepth,
        turnId: nestedInput.turnId,
        sessionId: nestedInput.sessionId,
        ...(reason ? { reason } : {}),
      };

      if (nextDepth > maxDepth) {
        const err = new MaxRecursionExceeded({
          runtimeId: manifest.name,
          depth: nextDepth,
          maxDepth,
        });
        await deps.emitter?.emit('recursive.failed', {
          ...tracePayload,
          error: err.message,
        });
        throw err;
      }

      await deps.emitter?.emit('recursive.calling', tracePayload);
      try {
        const nestedResult = await executeTurn(
          nestedInput,
          activeRuntimes,
          deps,
          {
            ...turnOptions,
            maxSteps,
            timeoutMs: defaultTimeoutMs,
            recursionDepth: nextDepth,
          },
        );
        await deps.emitter?.emit('recursive.completed', {
          ...tracePayload,
          resultCount: nestedResult.runtimeResults.length,
          durationMs: nestedResult.durationMs,
        });
        return nestedResult;
      } catch (err) {
        await deps.emitter?.emit('recursive.failed', {
          ...tracePayload,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    };
  };

  try {
    // ── Upstream gate (manifest.upstreamRequired) ─────────────────
    // Must run before loadRuntime so a failing upstream short-circuits
    // the whole pipeline: no prompt template read, no guard, no LLM call,
    // no runtime.started event. Emits a single runtime.completed{skipped}
    // so the frontend shows the runtime as skipped rather than hanging.
    const required = manifest.upstreamRequired ?? [];
    if (required.length > 0) {
      const missing = required.filter((id) => {
        const up = completedResults.get(id);
        if (!up && sessionMeta?.preGameCompleted?.includes(id)) return false;
        return !isRequiredUpstreamSatisfied(up);
      });
      if (missing.length > 0) {
        const reason = `upstream not success: ${missing.join(', ')}`;
        const skipResult: RuntimeResult = {
          pluginId: manifest.pluginId,
          runtimeId: manifest.name,
          runId,
          turnId: input.turnId,
          status: 'skipped',
          output: {
            skipped: true,
            reason,
            skippedBy: 'framework:upstreamRequired',
            missingUpstreams: missing,
          },
          toolCalls: [],
          durationMs: Date.now() - startTime,
          timestamp: new Date().toISOString(),
        };
        try {
          await deps.onRuntimeComplete?.({
            runtimeId: manifest.name,
            pluginId: manifest.pluginId,
            status: 'skipped',
            durationMs: skipResult.durationMs,
          });
        } catch { /* callback error must not kill runtime */ }
        emitSubEvent(deps.eventBus, 'runtime', 'runtime.completed', input.sessionId, {
          runtimeId: manifest.name,
          pluginId: manifest.pluginId,
          status: 'skipped',
          durationMs: skipResult.durationMs,
          reason,
        });
        return skipResult;
      }
    }

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
      const manualPayloadForRuntime =
        input.manualTrigger?.runtimeId === manifest.name
          ? input.manualTrigger.payload
          : undefined;
      const userSettingsForRuntime = resolveUserSettings(manifest, input.userSettings);
      const helperCtx = {
        sessionId: input.sessionId,
        turnId: input.turnId,
        pluginId: manifest.pluginId,
        runtimeId: manifest.name,
      };
      const assetProgress = createAssetProgressEmitter(deps.emitter, helperCtx);
      const pluginDataHandle = deps.store
        ? createPluginDataWriter(deps.store, helperCtx)
        : undefined;
      const loggerHandle = deps.store
        ? createPluginLogger(deps.store, helperCtx)
        : undefined;
      const mediaHandle = deps.mediaStore
        ? createRuntimeMediaContext(deps.mediaStore, deps.utils, {
            sessionId: input.sessionId,
            pluginId: manifest.pluginId,
          })
        : undefined;
      const isTrustedSource = isTrustedPluginSource(deps, manifest);
      const handlerStore = deps.store
        ? isTrustedSource
          ? deps.store
          : createFunctionStoreView(deps.store, helperCtx)
        : undefined;
      const output = await loaded.handler({
        sessionId: input.sessionId,
        turnId: input.turnId,
        pluginId: manifest.pluginId,
        playerMessage: input.playerMessage,
        locale: input.locale,
        store: handlerStore,
        completedResults,
        config,
        recursiveCall: createRecursiveCall(),
        recursionDepth,
        ...(deps.gateway ? { gateway: deps.gateway } : {}),
        ...(deps.utils ? { utils: deps.utils } : {}),
        ...(mediaHandle ? { media: mediaHandle } : {}),
        ...(assetProgress ? { assetProgress } : {}),
        ...(manualPayloadForRuntime ? { manualPayload: manualPayloadForRuntime } : {}),
        ...(triggerEvent ? { triggerEvent } : {}),
        ...(userSettingsForRuntime ? { userSettings: userSettingsForRuntime } : {}),
        ...(pluginDataHandle ? { pluginData: pluginDataHandle } : {}),
        ...(loggerHandle ? { logger: loggerHandle } : {}),
      });

      // ── Suspend detection for function runtimes (S4-T4) ────────────
      // If the handler returns { status: 'suspended', reason, resumeSchema } and
      // COVEL_SUSPEND_V1=1, persist a suspension and return status: 'suspended'.
      if (
        isEnvEnabled('COVEL_SUSPEND_V1') &&
        typeof output.status === 'string' &&
        output.status === 'suspended' &&
        typeof output.reason === 'string' &&
        deps.store
      ) {
        const suspensionId = crypto.randomUUID();
        // Function runtimes have no tool loop, so suspend records carry an
        // empty pendingProposals array and no partial content.
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
          },
          createdAt: new Date().toISOString(),
        };
        await deps.store.saveSuspension(suspension);

        emitSubEvent(deps.eventBus, 'game', 'turn.suspended', input.sessionId, {
          sessionId: input.sessionId,
          turnId: input.turnId,
          suspensionId,
          pluginId: manifest.pluginId,
          runtimeId: manifest.name,
          suspendedAt: suspension.createdAt,
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
          { pipeline: hookPipeline, sessionId: input.sessionId, turnId: input.turnId, pluginId: manifest.pluginId, runtimeId: manifest.name, eventBus: deps.eventBus, emitter: deps.emitter },
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

      // Save function output as TurnMessage (same as agent runtimes).
      // Manual plugin-rpc calls return their output to the caller and commit
      // proposals through plugin-rpc, so they stay out of conversation history.
      if (deps.store && !input.manualTrigger) {
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
          order: manifest.priority ?? 500,
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
        { pipeline: hookPipeline, sessionId: input.sessionId, turnId: input.turnId, pluginId: manifest.pluginId, runtimeId: manifest.name, eventBus: deps.eventBus, emitter: deps.emitter },
        result,
      );
    }

    // ── Guard: pre-execution gate for agent runtimes ────────────
    if (loaded.guard) {
      const guardConfig = deps.getConfig(manifest.pluginId, manifest.name);
      const guardManualPayload =
        input.manualTrigger?.runtimeId === manifest.name
          ? input.manualTrigger.payload
          : undefined;
      const guardUserSettings = resolveUserSettings(manifest, input.userSettings);
      const guardHelperCtx = {
        sessionId: input.sessionId,
        turnId: input.turnId,
        pluginId: manifest.pluginId,
        runtimeId: manifest.name,
      };
      const guardAssetProgress = createAssetProgressEmitter(deps.emitter, {
        sessionId: input.sessionId,
        turnId: input.turnId,
        pluginId: manifest.pluginId,
        runtimeId: manifest.name,
      });
      const guardStore = deps.store
        ? isTrustedPluginSource(deps, manifest)
          ? deps.store
          : createFunctionStoreView(deps.store, guardHelperCtx)
        : undefined;
      const guardPluginDataHandle = deps.store
        ? createPluginDataWriter(deps.store, guardHelperCtx)
        : undefined;
      const guardLoggerHandle = deps.store
        ? createPluginLogger(deps.store, guardHelperCtx)
        : undefined;
      const guardOutput = await loaded.guard({
        sessionId: input.sessionId,
        turnId: input.turnId,
        pluginId: manifest.pluginId,
        playerMessage: input.playerMessage,
        locale: input.locale,
        store: guardStore,
        completedResults,
        config: guardConfig,
        recursiveCall: createRecursiveCall(),
        recursionDepth,
        ...(deps.gateway ? { gateway: deps.gateway } : {}),
        ...(deps.utils ? { utils: deps.utils } : {}),
        ...(deps.mediaStore ? { media: createRuntimeMediaContext(deps.mediaStore, deps.utils, { sessionId: input.sessionId, pluginId: manifest.pluginId }) } : {}),
        ...(guardAssetProgress ? { assetProgress: guardAssetProgress } : {}),
        ...(guardManualPayload ? { manualPayload: guardManualPayload } : {}),
        ...(triggerEvent ? { triggerEvent } : {}),
        ...(guardUserSettings ? { userSettings: guardUserSettings } : {}),
        ...(guardPluginDataHandle ? { pluginData: guardPluginDataHandle } : {}),
        ...(guardLoggerHandle ? { logger: guardLoggerHandle } : {}),
      });

      if (guardOutput.skip === true) {
        // Record `skipped` in the internal RuntimeResult so downstream
        // consumers (Pre-Game completion tracker, session-kernel's
        // `result.status !== 'success'` gate, SSE payload) all see the same
        // story. Earlier code set `status: 'success'` here and only reported
        // 'skipped' in the outgoing SSE, which made the Pre-Game tracker's
        // `guardSkipped = result.status === 'skipped'` check dead code.
        const result: RuntimeResult = {
          pluginId: manifest.pluginId,
          runtimeId: manifest.name,
          runId,
          turnId: input.turnId,
          status: 'skipped',
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
            order: manifest.priority ?? 500,
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
          { pipeline: hookPipeline, sessionId: input.sessionId, turnId: input.turnId, pluginId: manifest.pluginId, runtimeId: manifest.name, eventBus: deps.eventBus, emitter: deps.emitter },
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
        { pipeline: hookPipeline, sessionId: input.sessionId, turnId: input.turnId, manifest, input, eventBus: deps.eventBus, emitter: deps.emitter },
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
      filteredHistory = messageHistory.filter((m) => {
        if (m.sourceType === 'player' || m.sourceType === 'system') return true;
        if (m.sourceType === 'runtime') {
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
      // Sprint 1-D: Thread the unified snapshot into context building so
      // `resolveVariableSources` (in prompt-internals.ts) can prefer
      // `sessionContext.legacyConfigView` over `config.__session_config__`.
      // Present only when COVEL_SESSION_CONTEXT=1 (flag-off path is undefined).
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
      { role: 'system', content: assembled.systemPrompt },
      ...assembled.messages,
    ];

    // LLM call with tool-calling loop
    let finalContent: string | null = null;
    const collectedToolCalls: ToolCallRecord[] = [];
    const executedToolCalls: ExecutedToolCallState[] = [];
    const failedToolCalls: FailedToolCallState[] = [];
    const pendingProposals: Proposal[] = [];
    let steps = 0;
    // Count streaming text deltas so the `message.completed` trace event can
    // report how many chunks the narrative was assembled from. Non-streaming
    // runtimes keep this at 0; trace consumers treat that as "not streamed".
    let streamDeltaCount = 0;

    const deadline = Date.now() + timeoutMs;
    let stoppedWithResponse = false;

    // Build tool definitions from manifest declarations (computed once, reused across steps).
    // The ToolCallContext is also passed so the executor can surface session-
    // specific variants (e.g. character tools with schema-typed `fields`).
    const toolContext = {
      sessionId: input.sessionId,
      turnId: input.turnId,
      pluginId: manifest.pluginId,
      runtimeId: manifest.name,
    } as const;
    const toolDefs = deps.toolExecutor
      ? buildToolDefinitions(manifest, deps.toolExecutor, toolContext)
      : undefined;
    const responseFormat = loaded.outputSchema
      ? { type: 'json_schema' as const, schema: loaded.outputSchema }
      : undefined;
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
    // stop (e.g. guide) set `maxSteps: 2` in their frontmatter to prevent
    // the LLM from running the same tool in a loop after it already succeeds.
    const effectiveMaxSteps = manifest.maxSteps ?? maxSteps;

    // Smart retry policy derived from manifest (maxRetries / callTimeoutMs /
    // firstTokenTimeoutMs / loopDetectionThreshold). A hung provider call now
    // fails fast inside the helper's per-attempt budget and retries with a
    // perturbation instead of burning the whole runtime timeout.
    const retryPolicy = buildRetryPolicy({
      maxRetries: manifest.maxRetries,
      callTimeoutMs: manifest.callTimeoutMs,
      firstTokenTimeoutMs: manifest.firstTokenTimeoutMs,
      loopDetectionThreshold: manifest.loopDetectionThreshold,
      runtimeTimeoutMs: timeoutMs,
    });
    const reportRetry = (info: RetryInfo): void => {
      const cause = info.error instanceof Error ? info.error.message : String(info.error);
      console.warn(
        `[runtime-retry] ${manifest.name} attempt=${info.attempt} reason=${info.reason} cause=${cause.slice(0, 200)}`,
      );
    };

    // Count how many times we injected a perturbation into `messages` due to
    // tool-loop detection. Once a loop has been perturbed and reappears, we
    // give up — another perturbation would not help.
    let loopPerturbations = 0;

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
        // Streaming path: helper enforces per-attempt call-timeout + first-
        // token (TTFB) guard, retries on transient failures, and forwards
        // text deltas to the caller on the first attempt (avoids duplicate
        // text in the chat stream when a retry happens). If streaming
        // exhausts its retries with a transient failure (e.g. provider SSE
        // never recovered), fall back to a single non-stream call — matches
        // the pre-helper behaviour for providers whose streaming path is
        // more fragile than their JSON completion endpoint.
        try {
          const streamed = await streamLLMWithRetry({
            llm: deps.llm,
            model: effectiveModel,
            messages,
            tools: toolDefs,
            responseFormat,
            policy: retryPolicy,
            deadline,
            onDelta: async (textDelta) => {
              streamDeltaCount++;
              try {
                await deps.onDelta!({
                  runtimeId: manifest.name,
                  pluginId: manifest.pluginId,
                  textDelta,
                });
              } catch {
                // Client disconnected — keep streaming to capture full content.
              }
            },
            onRetry: reportRetry,
            emitter: deps.emitter,
            runtimeId: manifest.name,
            pluginId: manifest.pluginId,
          });
          response = streamed.response;
        } catch (streamError) {
          if (streamError instanceof LLMRetryError && Date.now() < deadline) {
            console.warn(
              `[stream-recovery] ${manifest.name} streaming exhausted (reason=${streamError.reason}); falling back to non-stream generate()`,
            );
            response = await callLLMWithRetry({
              llm: deps.llm,
              model: effectiveModel,
              messages,
              tools: toolDefs,
              responseFormat,
              policy: retryPolicy,
              deadline,
              onRetry: reportRetry,
              emitter: deps.emitter,
              runtimeId: manifest.name,
              pluginId: manifest.pluginId,
            });
          } else {
            throw streamError;
          }
        }

        // If the stream finished with tool_calls but our adapter could not
        // parse structured calls out of delta chunks (some providers don't
        // deliver them on SSE), fall back to a non-stream call to get the
        // structured tool_calls payload.
        if (
          response.finishReason === 'tool_calls' &&
          response.toolCalls.length === 0 &&
          toolDefs
        ) {
          response = await callLLMWithRetry({
            llm: deps.llm,
            model: effectiveModel,
            messages,
            tools: toolDefs,
            responseFormat,
            policy: retryPolicy,
            deadline,
            onRetry: reportRetry,
            emitter: deps.emitter,
            runtimeId: manifest.name,
            pluginId: manifest.pluginId,
          });
        }
      } else {
        // Non-streaming path: helper handles transient-error + call-timeout
        // retry. A narrow secondary retry covers the DeepSeek-specific
        // "function.arguments JSON format" error which isTransientError does
        // not classify as retriable on its own.
        try {
          response = await callLLMWithRetry({
            llm: deps.llm,
            model: effectiveModel,
            messages,
            tools: toolDefs,
            responseFormat,
            policy: retryPolicy,
            deadline,
            onRetry: reportRetry,
            emitter: deps.emitter,
            runtimeId: manifest.name,
            pluginId: manifest.pluginId,
          });
        } catch (error) {
          const cause = error instanceof LLMRetryError ? error.cause : error;
          if (!toolDefs || !shouldRetryMalformedToolArguments(cause)) {
            throw error;
          }
          const fallbackCallStart = Date.now();
          if (deps.emitter) {
            // Malformed-tool-arguments fallback bypasses the retry helper, so
            // provider identity is not available here. Explicit `null` signals
            // "provider unknown at this call site" and survives JSON serialisation
            // (unlike `undefined`, which is dropped), keeping the payload schema
            // uniform across all 4 emit sites.
            await deps.emitter.emit('llm.calling', buildLlmCallingPayload({
              runtimeId: manifest.name,
              pluginId: manifest.pluginId,
              slot: effectiveModel,
              model: effectiveModel,
              provider: null,
              messages,
              tools: toolDefs,
              attempt: 0,
            }));
          }
          try {
            response = await deps.llm.generate({
              model: effectiveModel,
              messages,
              tools: toolDefs,
              responseFormat,
              signal: AbortSignal.timeout(
                Math.max(1000, Math.min(retryPolicy.callTimeoutMs, deadline - Date.now())),
              ),
            });
          } catch (fallbackErr) {
            // Pair every `llm.calling` with an `llm.responded` on the error
            // path so trace-viewer pairing stays intact when this fallback
            // generate throws.
            if (deps.emitter) {
              await deps.emitter.emit('llm.responded', buildLlmRespondedErrorPayload({
                runtimeId: manifest.name,
                pluginId: manifest.pluginId,
                error: fallbackErr,
                durationMs: Date.now() - fallbackCallStart,
                attempt: 0,
              }));
            }
            throw fallbackErr;
          }
          if (deps.emitter) {
            await deps.emitter.emit('llm.responded', buildLlmRespondedSuccessPayload({
              runtimeId: manifest.name,
              pluginId: manifest.pluginId,
              response,
              durationMs: Date.now() - fallbackCallStart,
              attempt: 0,
            }));
          }
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
        // reasoningContent is carried back verbatim so thinking-mode
        // providers (DashScope Qwen, DeepSeek v4) accept the follow-up turn.
        messages.push({
          role: 'assistant',
          content: response.content ?? '',
          toolCalls: response.toolCalls,
          ...(response.reasoningContent ? { reasoningContent: response.reasoningContent } : {}),
        });

        for (const tc of response.toolCalls) {
          if (deps.toolExecutor) {
            const tcStart = Date.now();

            // ── PreToolUse hook (S4-T3) ──────────────────────────
            const preToolOpts = { pipeline: hookPipeline, sessionId: input.sessionId, turnId: input.turnId, pluginId: manifest.pluginId, runtimeId: manifest.name, eventBus: deps.eventBus, emitter: deps.emitter };
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
              {
                sessionId: input.sessionId,
                turnId: input.turnId,
                pluginId: manifest.pluginId,
                runtimeId: manifest.name,
                pendingProposals: pendingProposals,
                emitter: deps.emitter,
              },
            );

            // ── PostToolUse hook (S4-T3) ─────────────────────────
            const toolResult = await runPostToolUseHook(preToolOpts, { id: effectiveTc.id, name: effectiveTc.name, arguments: effectiveTc.arguments }, result);

            if (!toolResult.success) {
              failedToolCalls.push({
                toolName: effectiveTc.name,
                message: extractToolFailureMessage(toolResult.result),
              });
            }

            if (toolResult.pendingProposals && toolResult.pendingProposals.length > 0) {
              pendingProposals.push(...toolResult.pendingProposals);
            }

            // ── Suspend detection (S4-T4) ────────────────────────
            // When COVEL_SUSPEND_V1=1 and the suspend tool was called, capture
            // the current loop state and persist a SuspensionRecord. The tool
            // result is NOT pushed back to the LLM — instead we exit the loop
            // with status 'suspended'.
            if (
              isEnvEnabled('COVEL_SUSPEND_V1') &&
              isSuspendSentinel(toolResult.parsedResult) &&
              deps.store
            ) {
              const sentinel = toolResult.parsedResult;
              const suspensionId = crypto.randomUUID();

              // Messages array currently has the assistant message (with tool_calls)
              // but not the suspend tool result. We capture the full message
              // array together with any buffered proposals so resume can
              // continue with the same mid-turn write set.
              const pendingContinuation: SuspensionRecord['pendingContinuation'] = {
                messages: [...messages],
                partialContent: finalContent ?? undefined,
                toolCallsSoFar: [...collectedToolCalls],
                pendingProposals: [...pendingProposals],
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

              // Emit turn.suspended SSE event via the actions channel.
              // Include pluginId/runtimeId/suspendedAt so web clients can
              // render a suspension row without a follow-up REST fetch
              // (F4 web suspend/resume integration).
              emitSubEvent(deps.eventBus, 'game', 'turn.suspended', input.sessionId, {
                sessionId: input.sessionId,
                turnId: input.turnId,
                suspensionId,
                pluginId: manifest.pluginId,
                runtimeId: manifest.name,
                suspendedAt: suspension.createdAt,
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
                { pipeline: hookPipeline, sessionId: input.sessionId, turnId: input.turnId, pluginId: manifest.pluginId, runtimeId: manifest.name, eventBus: deps.eventBus, emitter: deps.emitter },
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
              approvalStatus: toolResult.approvalStatus ?? 'auto-allowed',
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

        // Runtime-done early exit. If any tool call in this round was the
        // builtin `runtime-done` tool, the LLM has declared completion —
        // break immediately instead of burning another round-trip for a
        // terminator message. Business tool outputs from this round are
        // already in collectedToolCalls and become the runtime's output.
        // See packages/tools/src/builtin/runtime-done.ts for the sentinel
        // and buildFrameworkPreamble for the prompt contract.
        const doneCall = executedToolCalls.find((c) => isRuntimeDoneSentinel(c.result));
        if (doneCall) {
          // The runtime-done tool itself should not appear as a business
          // output — drop it from collected calls so downstream consumers
          // (proposal collector, trace) see only the real work.
          const businessCalls = collectedToolCalls.filter((c) => c.toolName !== 'runtime-done');
          collectedToolCalls.length = 0;
          collectedToolCalls.push(...businessCalls);
          // Preserve streamed / captured prose from earlier steps or this
          // step's response.content. Without this guard a story runtime that
          // interleaves narrative prose + tool calls + runtime-done would lose
          // every token of narrative to the JSON envelope below. Only fall
          // back to the envelope when the runtime produced NO prose at all
          // (plugin/system runtimes that call a tool and exit silently).
          if (!finalContent) {
            finalContent = businessCalls.length > 0
              ? JSON.stringify({ toolCalls: businessCalls.map((c) => ({ name: c.toolName, output: c.output })) })
              : '';
          }
          stoppedWithResponse = true;
          break;
        }

        // Tool-loop detection: when the LLM keeps emitting the exact same
        // tool call (name + JSON args) `threshold` times in a row it's
        // almost certainly stuck in a KV-cache echo. Inject a perturbation
        // system message to nudge it onto a different path; on the second
        // detection give up so the loop cannot wedge the runtime forever.
        if (retryPolicy.loopDetectionThreshold > 0) {
          const identityCalls = collectedToolCalls.map((c) => ({
            name: c.toolName,
            arguments: typeof c.input === 'string' ? c.input : JSON.stringify(c.input ?? {}),
          }));
          if (detectToolLoop(identityCalls, retryPolicy.loopDetectionThreshold)) {
            if (loopPerturbations >= 1) {
              throw new Error(
                `tool-loop detected for ${manifest.name}: same tool "${identityCalls[identityCalls.length - 1]?.name}" called ${retryPolicy.loopDetectionThreshold}+ times with identical arguments even after perturbation`,
              );
            }
            loopPerturbations++;
            const [hint] = perturbMessages([], 1, 'tool-loop-detected');
            if (hint) {
              messages.push(hint);
              console.warn(
                `[runtime-loop] ${manifest.name} detected repeated tool call; injected perturbation (attempt ${loopPerturbations})`,
              );
            }
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
        { pipeline: hookPipeline, sessionId: input.sessionId, turnId: input.turnId, pluginId: manifest.pluginId, runtimeId: manifest.name, eventBus: deps.eventBus, emitter: deps.emitter },
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
        manifest.outputKind !== 'story'
      ) {
        const preview = finalContent.slice(0, 220).replace(/\s+/g, ' ').trim();
        const requiredFields = extractRequiredFields(loaded.outputSchema);
        const requiredHint = requiredFields.length > 0
          ? ` Required fields: {${requiredFields.join(', ')}}.`
          : '';
        const failedResult: RuntimeResult = {
          pluginId: manifest.pluginId,
          runtimeId: manifest.name,
          runId,
          turnId: input.turnId,
          status: 'failed',
          // Preserve the full LLM output (`narrativeOutput`) plus a structured
          // diagnostic the task UI can render verbatim. The shape is stable so
          // a plugin's jobs.json can bind `value/runtimeResults/0/output/diagnostic`
          // and show the user the schema contract + raw output side-by-side.
          output: {
            narrativeOutput: finalContent,
            diagnostic: {
              kind: 'schema-validation-prose',
              requiredFields,
              schemaTitle:
                typeof loaded.outputSchema.title === 'string'
                  ? loaded.outputSchema.title
                  : undefined,
              llmOutput: finalContent,
              hint:
                'Model returned plain prose instead of JSON. Try a model with reliable structured-output mode, ' +
                'tighten the system prompt to enforce JSON, or relax overly strict schema fields.',
            },
          },
          toolCalls: collectedToolCalls,
          durationMs: Date.now() - startTime,
          error:
            `Runtime "${manifest.name}" expected a JSON envelope per output.schema but the model returned plain prose.` +
            requiredHint +
            ` Full LLM output preserved in runtimeResults[].output.narrativeOutput.` +
            ` Preview: "${preview}${finalContent.length > 220 ? '…' : ''}"`,
          timestamp: new Date().toISOString(),
        };
        emitSubEvent(deps.eventBus, 'runtime', 'runtime.failed', input.sessionId, {
          runtimeId: manifest.name,
          pluginId: manifest.pluginId,
          status: failedResult.status,
          durationMs: failedResult.durationMs,
          error: failedResult.error,
        });
        return runPostRuntimeHook(
          { pipeline: hookPipeline, sessionId: input.sessionId, turnId: input.turnId, pluginId: manifest.pluginId, runtimeId: manifest.name, eventBus: deps.eventBus, emitter: deps.emitter },
          failedResult,
        );
      }
      output = shouldSuppressToolLoopNarrative({
        outputKind: manifest.outputKind,
        executedToolCalls,
        parsedAsJson: parsed.parsedAsJson,
      })
        ? (structuredToolOutput ?? presentableToolOutput ?? { narrativeOutput: '' })
        : parsed.output;
      if (loaded.outputSchema && manifest.outputKind !== 'story') {
        const validation = validateOutput(output, loaded.outputSchema);
        if (!validation.valid) {
          const validationErrors = validation.errors ?? ['unknown schema validation error'];
          const failedResult: RuntimeResult = {
            pluginId: manifest.pluginId,
            runtimeId: manifest.name,
            runId,
            turnId: input.turnId,
            status: 'failed',
            output,
            toolCalls: collectedToolCalls,
            durationMs: Date.now() - startTime,
            error:
              `Runtime "${manifest.name}" output did not match output.schema: ` +
              validationErrors.slice(0, 5).join('; '),
            timestamp: new Date().toISOString(),
          };
          emitSubEvent(deps.eventBus, 'runtime', 'runtime.failed', input.sessionId, {
            runtimeId: manifest.name,
            pluginId: manifest.pluginId,
            status: failedResult.status,
            durationMs: failedResult.durationMs,
            error: failedResult.error,
          });
          return runPostRuntimeHook(
            { pipeline: hookPipeline, sessionId: input.sessionId, turnId: input.turnId, pluginId: manifest.pluginId, runtimeId: manifest.name, eventBus: deps.eventBus, emitter: deps.emitter },
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
        { pipeline: hookPipeline, sessionId: input.sessionId, turnId: input.turnId, pluginId: manifest.pluginId, runtimeId: manifest.name, eventBus: deps.eventBus, emitter: deps.emitter },
        result,
      );
    } else {
      output = presentableToolOutput ?? { narrativeOutput: '' };
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
      if (tc.success && tc.result && typeof tc.result === 'object') {
        const r = tc.result as Record<string, unknown>;
        if (r.interaction && typeof r.interaction === 'object') {
          const inter = r.interaction as Record<string, unknown>;
          const id = typeof inter.interactionId === 'string' ? inter.interactionId : '';
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

    if (pendingProposals.length > 0) {
      output = withPendingProposals(output, pendingProposals) as Record<string, unknown>;
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

    // Save runtime output as an append-only TurnMessage. Manual plugin-rpc
    // calls return their output to the caller and commit proposals through
    // plugin-rpc, so they stay out of conversation history.
    if (deps.store && !input.manualTrigger) {
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
    } catch { /* callback error must not kill runtime */ }

    // Emit a compact `message.completed` trace event for story runtimes that
    // produced non-empty narrative content. The realtime `message.delta`
    // channel keeps flowing per-token; this event is the single persisted
    // record of the final aggregated content and the delta count, so the
    // `/debug` timeline shows one row per runtime output instead of
    // thousands of per-token rows.
    if (deps.emitter && finalContent && manifest.outputKind === 'story') {
      await deps.emitter.emit('message.completed', {
        runtimeId: manifest.name,
        pluginId: manifest.pluginId,
        content: finalContent,
        len: finalContent.length,
        deltaCount: streamDeltaCount,
      });
    }

    emitSubEvent(deps.eventBus, 'runtime', 'runtime.completed', input.sessionId, {
      runtimeId: manifest.name,
      pluginId: manifest.pluginId,
      status: result.status,
      durationMs: result.durationMs,
    });

    // PostRuntime hook — agent success path (S4-T3)
    return runPostRuntimeHook(
      { pipeline: hookPipeline, sessionId: input.sessionId, turnId: input.turnId, pluginId: manifest.pluginId, runtimeId: manifest.name, eventBus: deps.eventBus, emitter: deps.emitter },
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
      error: message,
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
      { pipeline: hookPipeline, sessionId: input.sessionId, turnId: input.turnId, pluginId: manifest.pluginId, runtimeId: manifest.name, eventBus: deps.eventBus, emitter: deps.emitter },
      failedResult,
    );
  }
}

// buildToolDefinitions and makeFailedResult extracted to turn-executor-helpers.ts (S4-T3)
