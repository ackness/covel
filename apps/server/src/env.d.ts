import type { DataStore } from '@covel/store';
import type { PluginRegistry, LoadedRuntime } from '@covel/plugin-loader';
import type { StateManager } from '@covel/state';
import type { EventBus } from '@covel/events';
import type { LLMAdapter, ToolExecutor } from '@covel/runtime';
import type { RuntimeManifest } from '@covel/shared';

type LoadRuntimeFn = (manifest: RuntimeManifest, locale?: string) => Promise<LoadedRuntime | undefined>;
type GetConfigFn = (pluginId: string, runtimeId: string) => Readonly<Record<string, unknown>>;
type ResolveModelFn = (manifest: RuntimeManifest, apiOverride?: string) => string | undefined;

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
  }
}
