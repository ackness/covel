import type { DataStore } from '@covel/store';
import type { PluginRegistry, LoadedRuntime } from '@covel/plugin-loader';
import type { StateManager } from '@covel/state';
import type { EventBus } from '@covel/events';
import type { LLMAdapter, ToolExecutor, RpcExecutor, PluginRpcRegistry } from '@covel/runtime';
import type { RpcApprovalGate } from '@covel/approval';
import type { RuntimeManifest } from '@covel/shared';
import type { CompactorRunner } from '@covel/context';

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
    ensureEmbeddingLock?: EnsureEmbeddingLockFn;
  }
}
