import type { RuntimeManifest, TurnInput } from "@covel/shared";
import type {
  LoadedRuntime,
  PluginRuntimeGateway,
  PluginRuntimeUtils,
  PluginSource,
} from "@covel/plugin-loader";
import type { DataStore } from "@covel/store";
import type {
  BudgetOptions,
  CompactorRunner,
  TokenEstimator,
} from "@covel/context";
import type { EventBus } from "@covel/events";
import type { LLMAdapter } from "./llm-adapter.js";
import type { ToolExecutor } from "./tool-executor.js";
import type { HookPipeline } from "./hooks/pipeline.js";
import type { MediaStoreLike } from "./runtime-media-context.js";

export interface TurnExecutorDeps {
  /** Resolve a runtime manifest to its fully loaded data. Locale enables localized PLUGIN.md (e.g., PLUGIN.en.md). */
  readonly loadRuntime: (
    manifest: RuntimeManifest,
    locale?: string,
  ) => Promise<LoadedRuntime | undefined>;
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
  readonly getConfig: (
    pluginId: string,
    runtimeId: string,
  ) => Readonly<Record<string, unknown>>;
  /** Optional DataStore for persisting results. */
  readonly store?: DataStore;
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

  /** Optional EventBus for emitting subscription events during turn execution. */
  readonly eventBus?: EventBus;

  /** Called for each LLM text delta during streaming (narrative-only runtimes). */
  readonly onDelta?: (delta: {
    runtimeId: string;
    pluginId: string;
    textDelta: string;
  }) => Promise<void>;
  /** Called when a runtime starts execution. */
  readonly onRuntimeStart?: (info: {
    runtimeId: string;
    pluginId: string;
    priority: number | undefined;
  }) => Promise<void>;
  /** Called when a runtime completes execution. */
  readonly onRuntimeComplete?: (info: {
    runtimeId: string;
    pluginId: string;
    status: string;
    durationMs: number;
    error?: string;
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
   * Optional hook pipeline. When present, lifecycle hooks fire at 8 points
   * during turn execution. When absent, all hook sites are pure no-ops —
   * identical to pre-hook behaviour. Plugin hooks are registered by
   * bootstrap; callers that build the executor directly (CLI tools, tests)
   * can pass `undefined` to keep the non-hook fast path.
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
      loadBlocks(
        sessionId: string,
      ): Promise<
        readonly { label: string; content: string; updatedAt: string }[]
      >;
      initializeDefaults(sessionId: string): Promise<void>;
    };
    readonly updater: {
      updateAfterTurn(params: {
        sessionId: string;
        narrativeText: string;
        toolCallSummaries?: readonly string[];
        currentBlocks: readonly {
          label: string;
          content: string;
          updatedAt: string;
        }[];
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
   * Optional world data plugin ID (Sprint 1-D). Resolved by the server via
   * `pluginRegistry.findPluginByCapability(sessionId, 'world-data-provider')`
   * and passed down so `buildSessionContextSnapshot` can fetch the active
   * world's plugin_data (schema, dimensions, tone, opening scenario).
   *
   * Consulted by `buildSessionContextSnapshot` when a store is available.
   */
  readonly worldDataPluginId?: string;

  /**
   * Optional persona provider plugin ID. Resolved by the server via
   * `pluginRegistry.findPluginByCapability(sessionId, 'persona-provider')`
   * and passed down so `buildSessionContextSnapshot` can load the active
   * player persona from that plugin's `session-binding` / `profiles`
   * namespaces. Framework never hardcodes a plugin id.
   */
  readonly personaPluginId?: string;

  /**
   * Optional prompt-history rewriter plugin ID. Resolved by the server via
   * `pluginRegistry.findPluginByCapability(sessionId, 'prompt-history-rewriter')`
   * and passed down so `buildProjectedPromptHistory` can fold that plugin's
   * accepted alternate turns into the projected history. Framework never
   * hardcodes a plugin id.
   */
  readonly promptHistoryRewriterPluginId?: string;

  /**
   * Trace emitter for per-turn observability. When present, runtime emits
   * tool.calling / tool.completed / llm.calling / llm.responded / message.completed
   * etc. into trace_events and the action SSE stream via eventBus.
   * Optional for backward compatibility with tests and embedders.
   */
  readonly emitter?: import("./turn-emitter.js").TurnEmitter;
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
