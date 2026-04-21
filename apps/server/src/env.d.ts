import type { DataStore } from '@covel/store';
import type { PluginRegistry, LoadedRuntime } from '@covel/plugin-loader';
import type { StateManager } from '@covel/state';
import type { EventBus } from '@covel/events';
import type { LLMAdapter, ToolExecutor, RpcExecutor, PluginRpcRegistry, HookPipeline } from '@covel/runtime';
import type { RpcApprovalGate } from '@covel/approval';
import type { RuntimeManifest } from '@covel/shared';
import type { CompactorRunner } from '@covel/context';
import type { SessionLock } from './lib/session-lock.js';

type LoadRuntimeFn = (manifest: RuntimeManifest, locale?: string) => Promise<LoadedRuntime | undefined>;
type GetConfigFn = (pluginId: string, runtimeId: string) => Readonly<Record<string, unknown>>;
type ResolveModelFn = (manifest: RuntimeManifest, apiOverride?: string) => string | undefined;
type EnsureEmbeddingLockFn = (sessionId: string) => Promise<void>;

// (sessionScopes context var removed 2026-04-12 — see audit Finding 2)

declare module 'hono' {
  interface ContextVariableMap {
    store: DataStore;
    stateManager: StateManager;
    eventBus: EventBus;
    pluginRegistry: PluginRegistry;
    llmAdapter: LLMAdapter;
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
    ensureEmbeddingLock?: EnsureEmbeddingLockFn;
    hookPipeline?: HookPipeline;
  }
}
