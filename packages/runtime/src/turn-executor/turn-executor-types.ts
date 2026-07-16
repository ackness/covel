import type { RuntimeManifest, TurnInput } from "@covel/shared";
import type {
  LoadedRuntime,
  PluginRuntimeGateway,
  PluginRuntimeUtils,
  PluginSource,
} from "@covel/plugin-loader";
import type { DataStore, WorkingMemoryRecord } from "@covel/store";
import type {
  BudgetOptions,
  CompactorRunner,
  CoreMemoryBlockView,
  TokenEstimator,
} from "@covel/context";
import type { EventBus } from "@covel/events";
import type { LLMAdapter } from "../llm/llm-adapter.js";
import type { TurnControl } from "./turn-control.js";
import type { ToolExecutor } from "../agent-loop/tool-executor.js";
import type { HookPipeline } from "../hooks/pipeline.js";
import type { MediaStoreLike } from "../function-runtime/runtime-media-context.js";

/**
 * Narrow dependency surface the **core agent loop** consumes.
 *
 * Separation seam (pi's core-loop vs harness): `runAgentToolLoop` and its
 * helpers (`requestLLMResponse`, `handleSuspension`) depend only on these
 * execution + observability fields. Orchestration concerns — context
 * assembly, compaction, memory, capability-provider ids, plugin loading —
 * live on `TurnExecutorDeps` and are intentionally invisible here, so the
 * core loop cannot reach into them.
 *
 * `TurnExecutorDeps extends AgentLoopDeps`, so the fully-wired deps object is
 * still assignable wherever `AgentLoopDeps` is expected.
 */
export interface AgentLoopDeps {
  /** LLM adapter for making model calls. */
  readonly llm: LLMAdapter;
  /** Optional tool executor for handling LLM tool calls. */
  readonly toolExecutor?: ToolExecutor;
  /**
   * Resolve the effective model for a runtime.
   * Priority: API modelOverride > plugin llm.toml default > manifest.model > undefined (system default).
   */
  readonly resolveModel?: (
    manifest: RuntimeManifest,
    apiOverride?: string,
  ) => string | undefined;
  /**
   * Optional DataStore. Within the core loop this is the persistence escape
   * hatch for suspension records only; broader persistence is orchestrated by
   * the harness. (Candidate to hoist out of the loop entirely in S3.)
   */
  readonly store?: DataStore;
  /** Optional EventBus for emitting subscription events during turn execution. */
  readonly eventBus?: EventBus;
  /** Called for each LLM text delta during streaming (narrative-only runtimes). */
  readonly onDelta?: (delta: {
    runtimeId: string;
    pluginId: string;
    textDelta: string;
  }) => Promise<void>;
  /** Called when a runtime completes execution (e.g. on suspension). */
  readonly onRuntimeComplete?: (info: {
    runtimeId: string;
    pluginId: string;
    status: string;
    durationMs: number;
    error?: string;
  }) => Promise<void>;
  /**
   * Trace emitter for per-turn observability. When present, runtime emits
   * tool.calling / tool.completed / llm.calling / llm.responded / message.completed
   * etc. into trace_events and the action SSE stream via eventBus.
   * Optional for backward compatibility with tests and embedders.
   */
  readonly emitter?: import("../trace/turn-emitter.js").TurnEmitter;
  /**
   * Player mid-turn control (roadmap W4): abort signal + steering queue.
   * Absent on server-initiated turns (background followers, plugin-rpc) and
   * in test harnesses — all control sites are optional-chained.
   */
  readonly turnControl?: TurnControl;
}

export interface TurnExecutorDeps extends AgentLoopDeps {
  /** Resolve a runtime manifest to its fully loaded data. Locale enables localized PLUGIN.md (e.g., PLUGIN.en.md). */
  readonly loadRuntime: (
    manifest: RuntimeManifest,
    locale?: string,
    sessionId?: string,
  ) => Promise<LoadedRuntime | undefined>;
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
  readonly getConfig: (
    pluginId: string,
    runtimeId: string,
  ) => Readonly<Record<string, unknown>>;

  /** Called when a runtime starts execution. */
  readonly onRuntimeStart?: (info: {
    runtimeId: string;
    pluginId: string;
    priority: number | undefined;
  }) => Promise<void>;

  /**
   * Optional token estimator for context budgeting. When provided together
   * with `contextBudget`, the message history is pruned before it is handed
   * to the LLM. See packages/context/src/budget.ts.
   */
  readonly estimator?: TokenEstimator;

  /**
   * Optional budget configuration. Only honored when `estimator` is also present.
   * Same shape as `BudgetOptions` from @covel/context minus the `estimator` field
   * (which is threaded separately so callers can share one estimator across many
   * runtimes).
   */
  readonly contextBudget?: Omit<BudgetOptions, "estimator">;

  /**
   * Optional hook pipeline. When present, lifecycle hooks fire at the turn's
   * hook sites. When absent, all hook sites are pure no-ops — identical to
   * pre-hook behaviour. Plugin hooks are registered by bootstrap; callers that
   * build the executor directly (CLI tools, tests) can pass `undefined` to
   * keep the non-hook fast path.
   */
  readonly hookPipeline?: HookPipeline;

  /**
   * Optional compactor runner. When present, the compactor runs before
   * `buildContext` to summarize old history.
   */
  readonly compactor?: CompactorRunner;

  /**
   * Optional memory system (Letta-style three-tier memory).
   * When present:
   *   - Pre-turn: loads core memory blocks and passes to buildContext
   *   - Post-turn: calls memory updater to refresh blocks from turn results
   */
  readonly memorySystem?: {
    readonly manager: {
      // Carries the schema-driven `displayName` (see CoreMemoryBlockView) so it
      // is not erased at the deps boundary — the turn pipeline threads it intact
      // through to renderCoreMemory. The optional `existing` param accepts the
      // turn's single listWorkingMemory read so the manager skips its own
      // re-read (R-13); it must be a fresh, complete list when provided.
      loadBlocks(
        sessionId: string,
        existing?: readonly WorkingMemoryRecord[],
      ): Promise<readonly CoreMemoryBlockView[]>;
      initializeDefaults(
        sessionId: string,
        existing?: readonly WorkingMemoryRecord[],
      ): Promise<void>;
    };
    readonly updater: {
      updateAfterTurn(params: {
        sessionId: string;
        narrativeText: string;
        toolCallSummaries?: readonly string[];
        currentBlocks: readonly CoreMemoryBlockView[];
        locale?: string;
      }): Promise<{
        updated: boolean;
        blocksChanged: readonly string[];
        error?: string;
      }>;
      /** Optional — await any pending updateAfterTurn for the session. */
      awaitPending?(sessionId: string): Promise<void>;
    };
  };

  /**
   * Framework-capability plugin ids the turn pipeline consumes, discovered by
   * the server via `pluginRegistry.findPluginByCapability` (framework never
   * hardcodes plugin ids). Grouped so the resolver result flows as one object
   * rather than three loose deps fields. Absent capability → feature off.
   */
  readonly capabilityPluginIds?: CapabilityPluginIds;

  /**
   * Optional session event directory (unified event emission layer, plan
   * task 4/5). When present, an agent runtime whose manifest declares
   * `advertiseEvents: true` gets `catalogText`'s rendered output threaded
   * into `ContextBuildParams.eventCatalogText` for segment 5 injection.
   * Structural type — satisfied by `apps/server`'s `EventDirectory`. Absent
   * in test harnesses that don't wire the server bootstrap.
   */
  readonly eventDirectory?: {
    catalogText(sessionId: string, locale: string): Promise<string>;
  };
}

/** Plugin ids discovered by framework capability for the turn pipeline. */
export interface CapabilityPluginIds {
  /** `world-data-provider` — world dimensions / lorebook / opening scenario. */
  readonly worldDataPluginId?: string;
  /** `persona-provider` — the active player persona. */
  readonly personaPluginId?: string;
  /** `prompt-history-rewriter` — accepted branch-reply candidate projection. */
  readonly promptHistoryRewriterPluginId?: string;
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

export interface TurnInputExecutionFlags {
  readonly suppressPlayerMessage?: boolean;
}

export class MaxRecursionExceeded extends Error {
  readonly code = "MAX_RECURSION_EXCEEDED" as const;
  readonly depth: number;
  readonly maxDepth: number;
  readonly runtimeId: string;

  constructor(args: { runtimeId: string; depth: number; maxDepth: number }) {
    super(
      `recursiveCall exceeded max depth ${args.maxDepth} for runtime "${args.runtimeId}"`,
    );
    this.name = "MaxRecursionExceeded";
    this.runtimeId = args.runtimeId;
    this.depth = args.depth;
    this.maxDepth = args.maxDepth;
  }
}

export type RecursiveTurnInput = TurnInput & TurnInputExecutionFlags;
