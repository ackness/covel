import type { DataStore, MediaStore } from "@covel/store";
import type {
  PluginRegistry,
  LoadedRuntime,
  PluginRuntimeGateway,
  PluginRuntimeUtils,
  PluginSource,
} from "@covel/plugin-loader";
import type { StateManager } from "@covel/state";
import type { EventBus } from "@covel/events";
import type {
  LLMAdapter,
  ToolExecutor,
  RpcExecutor,
  PluginRpcRegistry,
  HookPipeline,
} from "@covel/runtime";
import type { RpcApprovalGate } from "@covel/approval";
import type { RuntimeManifest } from "@covel/shared";
import type { CompactorRunner } from "@covel/context";
import type { SessionLock } from "./lib/session-lock.js";

type LoadRuntimeFn = (
  manifest: RuntimeManifest,
  locale?: string,
) => Promise<LoadedRuntime | undefined>;
type GetConfigFn = (
  pluginId: string,
  runtimeId: string,
) => Readonly<Record<string, unknown>>;
type ResolveModelFn = (
  manifest: RuntimeManifest,
  apiOverride?: string,
) => string | undefined;
type EnsureEmbeddingLockFn = (sessionId: string) => Promise<void>;
type PrepareToolsForSessionFn = (sessionId: string) => Promise<void>;
type GetPluginSourceFn = (pluginId: string) => PluginSource | undefined;
/**
 * Activate a community plugin's `tools.local` modules — only loaded after
 * approval. Idempotent: returns immediately on the second call. No-op for
 * builtin/official plugins (their tools are loaded at boot).
 */
type ActivatePluginLocalToolsFn = (pluginId: string) => Promise<void>;

declare module "hono" {
  interface ContextVariableMap {
    store: DataStore;
    stateManager: StateManager;
    eventBus: EventBus;
    pluginRegistry: PluginRegistry;
    llmAdapter: LLMAdapter;
    /**
     * Narrow gateway facade exposed to function-runtime handlers via
     * `FunctionHandlerContext.gateway`. Set by `bootstrapApi()` when the
     * caller provides a `pluginGateway`; absent when running with the
     * minimal test-harness LLMAdapter only.
     */
    pluginGateway?: PluginRuntimeGateway;
    /**
     * Stateless plugin-facing utility surface (SSRF guard + retrying
     * fetch) exposed via `FunctionHandlerContext.utils`. Set by
     * `bootstrapApi()` when the caller provides `pluginUtils`.
     */
    pluginUtils?: PluginRuntimeUtils;
    loadRuntimeFn: LoadRuntimeFn;
    toolExecutor: ToolExecutor;
    getConfigFn: GetConfigFn;
    resolveModel: ResolveModelFn;
    compactorRunner: CompactorRunner;
    rpcExecutor: RpcExecutor;
    rpcRegistry: PluginRpcRegistry;
    rpcApprovalGate: RpcApprovalGate;
    /**
     * Per-session serializer. Injected by `bootstrapApi()`:
     *   - `STORE_BACKEND=pg` → `createPgAdvisorySessionLock(sql)` — mutual
     *     exclusion across Node pods via `pg_advisory_lock`.
     *   - everything else → `createInProcessSessionLock()` — `Map`-based
     *     chain, correct for single-process deployments.
     *
     * Route handlers MUST use this instead of the legacy `withSessionLock`
     * import so PG deployments automatically get cross-pod safety.
     */
    sessionLock: SessionLock;
    /**
     * Content-addressable media store used by `/api/media/:id`,
     * `/api/sessions/:id/media-token`, and runtime `ctx.media`.
     */
    mediaStore?: MediaStore;
    builtinToolNames?: readonly string[];
    worldsDirs?: readonly string[];
    covelHome?: string;
    ensureEmbeddingLock?: EnsureEmbeddingLockFn;
    hookPipeline?: HookPipeline;
    /**
     * Refresh per-session tool override cache. Action handlers should call
     * this immediately before `executeTurn` so the LLM sees the freshest
     * schema-aware variants of `(create|update)-character`. Optional so
     * tests with hand-built DI middleware don't have to wire the cache —
     * handlers must use optional-chaining: `await c.get('prepareToolsForSession')?.(sid)`.
     */
    prepareToolsForSession?: PrepareToolsForSessionFn;
    getPluginSource?: GetPluginSourceFn;
    /**
     * Reserved plugin IDs (the bundled `plugins/` set, derived at boot from
     * the discovery result via `deriveBuiltinPluginIds`). The plugin install
     * route rejects any third-party package whose id collides with one of
     * these so a community plugin can never shadow a builtin's `plugin_data`
     * namespace. Optional so test harnesses that mount the install routes
     * without the bootstrap DI middleware don't have to wire it.
     */
    reservedPluginIds?: ReadonlySet<string>;
    /**
     * Activates a community plugin's `tools.local` modules. Called from the
     * plugin-rpc executor right before a runtime runs (so the tools resolve)
     * and from the approvals decision route after `allow` (so the tools are
     * pre-loaded before the renderer retries the original RPC).
     *
     * Optional so tests with hand-built DI middleware don't have to wire it.
     */
    activatePluginLocalTools?: ActivatePluginLocalToolsFn;
  }
}
