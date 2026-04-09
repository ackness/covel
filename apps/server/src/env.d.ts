import type { DataStore } from '@covel/store';
import type { PluginRegistry, LoadedRuntime, SessionPluginScope } from '@covel/plugin-loader';
import type { StateManager } from '@covel/state';
import type { EventBus } from '@covel/events';
import type { LLMAdapter, ToolExecutor } from '@covel/runtime';
import type { RuntimeManifest } from '@covel/shared';

type LoadRuntimeFn = (manifest: RuntimeManifest, locale?: string) => Promise<LoadedRuntime | undefined>;
type GetConfigFn = (pluginId: string, runtimeId: string) => Readonly<Record<string, unknown>>;
type ResolveModelFn = (slotOrModel: string, pluginId?: string) => string;

declare module 'hono' {
  interface ContextVariableMap {
    store: DataStore;
    stateManager: StateManager;
    eventBus: EventBus;
    pluginRegistry: PluginRegistry;
    sessionScopes: Map<string, SessionPluginScope>;
    llmAdapter: LLMAdapter;
    loadRuntimeFn: LoadRuntimeFn;
    toolExecutor: ToolExecutor;
    getConfigFn: GetConfigFn;
    resolveModel: ResolveModelFn;
  }
}
