/**
 * V2 Bootstrap — creates a fully wired Hono app with all dependencies injected.
 *
 * This module assembles the dependency graph and returns a ready-to-use app.
 * Can be used by the real server or by tests with mock dependencies.
 */

import path from 'node:path';
import { Hono } from 'hono';
import type { RuntimeManifest } from '@covel/shared';
import {
  createPluginRegistry,
  discoverPlugins,
  loadPluginSummary,
  loadPluginManifest,
  loadRuntime as loadRuntimeFromDisk,
  type PluginRegistry,
  type LoadedRuntime,
  type PluginDiscoveryResult,
  type ParsedPluginMd,
} from '@covel/plugin-loader';
import { createStateManager, type StateManager } from '@covel/state';
import { createEventBus, type EventBus } from '@covel/events';
import type { DataStore } from '@covel/store';
import type { LLMAdapter, ToolExecutor } from '@covel/runtime';
import { createToolExecutor } from '@covel/runtime';
import { builtinUITools, type ToolModule } from '@covel/tools';

import { sessionRoutes } from './session.js';
import { turnRoutes } from './turn.js';
import { pluginRoutes } from './plugins.js';
import { stateRoutes } from './state.js';
import { eventRoutes } from './events.js';
import { runtimeRoutes } from './runtime.js';
import { healthRoutes } from './health.js';
import { submitInputsRoutes } from './submit-inputs.js';

// ── Bootstrap config ─────────────────────────────────────────────

export interface V2BootstrapConfig {
  /** Path to plugins directory (e.g., 'plugins-v2/'). */
  readonly pluginsDir: string;
  /** LLM adapter (real or mock). */
  readonly llmAdapter: LLMAdapter;
  /** DataStore for all persistence. */
  readonly store: DataStore;
  /** Optional pre-created state manager. */
  readonly stateManager?: StateManager;
  /** Optional config provider for injecting world context etc. into runtime execution. */
  readonly getConfigFn?: (pluginId: string, runtimeId: string) => Readonly<Record<string, unknown>>;
}

export interface V2BootstrapResult {
  readonly app: Hono;
  readonly registry: PluginRegistry;
  readonly stateManager: StateManager;
  readonly store: DataStore;
  readonly eventBus: EventBus;
}

// ── Bootstrap function ───────────────────────────────────────────

/**
 * Create a fully wired V2 Hono app.
 *
 * 1. Discover and register all plugins
 * 2. Create shared state (session store, state manager, etc.)
 * 3. Inject all dependencies into routes via middleware
 * 4. Mount all route groups
 */
export async function bootstrapV2(config: V2BootstrapConfig): Promise<V2BootstrapResult> {
  // 1. Discover plugins
  const registry = createPluginRegistry();
  const discoveries = await discoverPlugins(config.pluginsDir);

  // Preload and register each plugin
  const discoveryMap = new Map<string, PluginDiscoveryResult>();
  const manifestCache = new Map<string, readonly ParsedPluginMd[]>();

  for (const discovery of discoveries) {
    discoveryMap.set(discovery.id, discovery);

    const summary = await loadPluginSummary(discovery);
    const manifests = await loadPluginManifest(discovery);
    manifestCache.set(discovery.id, manifests);

    // Register with first manifest for getActiveRuntimes
    registry.register({
      id: discovery.id,
      summary,
      manifest: manifests[0],
      loadedRuntimes: new Map(),
      status: 'registered',
    });
  }

  // 2. Create shared state
  const { store } = config;
  const stateManager = config.stateManager ?? createStateManager(store);
  const eventBus = createEventBus(store);
  const sessionScopes = new Map();

  // 3. loadRuntime resolver
  const loadRuntimeFn = async (manifest: RuntimeManifest): Promise<LoadedRuntime | undefined> => {
    // Find the discovery for this manifest
    for (const [pluginId, discovery] of discoveryMap) {
      const manifests = manifestCache.get(pluginId);
      if (manifests?.some((m) => m.manifest.name === manifest.name)) {
        return loadRuntimeFromDisk(discovery, manifest.name);
      }
    }
    return undefined;
  };

  // 4. Create ToolExecutor with builtin + plugin local tools
  const toolMap = new Map<string, ToolModule>();
  for (const t of builtinUITools) {
    toolMap.set(t.name, t);
  }
  // Load plugin local tools from tools/ directories
  for (const [pluginId, discovery] of discoveryMap) {
    const manifests = manifestCache.get(pluginId);
    if (!manifests) continue;
    for (const parsed of manifests) {
      const localPaths = parsed.manifest.tools?.local ?? [];
      for (const localPath of localPaths) {
        try {
          const fullPath = path.resolve(discovery.rootPath, localPath);
          const mod = await import(fullPath);
          const toolModule = mod.default ?? Object.values(mod).find((v: unknown) => (v as Record<string, unknown>)?._type === 'covel-tool');
          if (toolModule && (toolModule as Record<string, unknown>)._type === 'covel-tool') {
            toolMap.set((toolModule as ToolModule).name, toolModule as ToolModule);
          }
        } catch (err) {
          console.warn(`[bootstrap] Failed to load local tool ${localPath} from ${pluginId}:`, err);
        }
      }
    }
  }

  const toolExecutor = createToolExecutor({
    findTool: (name) => toolMap.get(name),
    store,
  });

  // 5. Create app with dependency injection middleware
  const app = new Hono();

  app.use('*', async (c, next) => {
    c.set('store', store);
    c.set('stateManager', stateManager);
    c.set('eventBus', eventBus);
    c.set('pluginRegistry', registry);
    c.set('sessionScopes', sessionScopes);
    c.set('llmAdapter', config.llmAdapter);
    c.set('loadRuntimeFn', loadRuntimeFn);
    c.set('toolExecutor', toolExecutor);
    if (config.getConfigFn) {
      c.set('getConfigFn', config.getConfigFn);
    }
    await next();
  });

  // 6. Mount routes
  app.route('/v2/session', sessionRoutes);
  app.route('/v2/session', turnRoutes);
  app.route('/v2/plugins', pluginRoutes);
  app.route('/v2/session', stateRoutes);
  app.route('/v2/session', submitInputsRoutes);
  app.route('/v2/events', eventRoutes);
  app.route('/v2/runtime', runtimeRoutes);
  app.route('/v2/health', healthRoutes);

  return { app, registry, stateManager, store, eventBus };
}
