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
import { builtinUITools, tool, type ToolModule } from '@covel/tools';
import { z } from 'zod';
import { createApprovalPipeline } from '@covel/approval';
import type { PermissionRule } from '@covel/approval';

import { sessionRoutes } from './session.js';
import { turnRoutes } from './turn.js';
import { pluginRoutes } from './plugins.js';
import { stateRoutes } from './state.js';
import { eventRoutes } from './events.js';
import { runtimeRoutes } from './runtime.js';
import { healthRoutes } from './health.js';
import { submitInputsRoutes } from './submit-inputs.js';
import { worldRoutes } from './worlds.js';
import { messageRoutes } from './messages.js';
import { characterRoutes } from './characters.js';
import { actionRoutes } from './actions.js';
import { subscribeRoutes } from './subscribe.js';

// ── Bootstrap config ─────────────────────────────────────────────

export interface V2BootstrapConfig {
  /** Path to plugins directory (e.g., 'plugins/'). */
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
  // 1. Create shared infrastructure first (eventBus needed by registry)
  const { store } = config;
  const stateManager = config.stateManager ?? createStateManager(store);
  const eventBus = createEventBus(store);

  // 2. Discover plugins
  const registry = createPluginRegistry({ eventBus });
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

  // 3. Create remaining shared state
  const sessionScopes = new Map();

  // 4. loadRuntime resolver (locale-aware: loads PLUGIN.en.md when locale is "en-US")
  const loadRuntimeFn = async (manifest: RuntimeManifest, locale?: string): Promise<LoadedRuntime | undefined> => {
    for (const [pluginId, discovery] of discoveryMap) {
      const manifests = manifestCache.get(pluginId);
      if (manifests?.some((m) => m.manifest.name === manifest.name)) {
        return loadRuntimeFromDisk(discovery, manifest.name, locale);
      }
    }
    return undefined;
  };

  // 5. Create ToolExecutor with builtin + plugin local tools + approval
  const builtinToolNames = new Set<string>();
  const localToolNames = new Set<string>();
  const toolMap = new Map<string, ToolModule>();

  for (const t of builtinUITools) {
    toolMap.set(t.name, t);
    builtinToolNames.add(t.name);
  }

  // Injection context for factory-style tools (zero-dep plugin tools)
  const toolInjection = { tool, z };

  // Load plugin local tools from tools/ directories
  for (const [pluginId, discovery] of discoveryMap) {
    const manifests = manifestCache.get(pluginId);
    if (!manifests) continue;
    for (const parsed of manifests) {
      const localPaths = parsed.manifest.tools?.local ?? [];
      for (const localPath of localPaths) {
        try {
          const fullPath = path.resolve(discovery.rootPath, localPath);
          // Security: prevent path traversal outside plugin root
          const rel = path.relative(discovery.rootPath, fullPath);
          if (rel.startsWith('..') || path.isAbsolute(rel)) {
            console.warn(`[bootstrap] Rejected path traversal: ${localPath} from ${pluginId}`);
            continue;
          }
          const mod = await import(fullPath);
          const exported = mod.default ?? Object.values(mod)[0];

          let toolModule: ToolModule | undefined;

          if (typeof exported === 'function') {
            // Factory function: export default function({ tool, z }) { ... }
            const result = exported(toolInjection);
            if (result && (result as Record<string, unknown>)._type === 'covel-tool') {
              toolModule = result as ToolModule;
            }
          } else if (exported && (exported as Record<string, unknown>)._type === 'covel-tool') {
            // Direct ToolModule export (legacy/TS style)
            toolModule = exported as ToolModule;
          }

          if (toolModule) {
            toolMap.set(toolModule.name, toolModule);
            localToolNames.add(toolModule.name);
          }
        } catch (err) {
          console.warn(`[bootstrap] Failed to load local tool ${localPath} from ${pluginId}:`, err);
        }
      }
    }
  }

  // Approval: whitelist builtin + known local tools, deny unknown third-party
  const approvalRules: PermissionRule[] = [
    { pattern: 'builtin:*', action: 'allow' },
    { pattern: 'local:*', action: 'allow' },
    { pattern: 'third-party:*', action: 'deny' },
  ];
  const approval = createApprovalPipeline(store, approvalRules);

  const toolExecutor = createToolExecutor({
    findTool: (name) => toolMap.get(name),
    store,
    approval,
    getToolSource: (name) => {
      if (builtinToolNames.has(name)) return 'builtin';
      if (localToolNames.has(name)) return 'local';
      return 'third-party';
    },
  });

  // 6. Create app with dependency injection middleware
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

  // 7. Mount routes
  app.route('/v2/sessions', sessionRoutes);
  app.route('/v2/session', sessionRoutes);
  app.route('/v2/session', turnRoutes);
  app.route('/v2/plugins', pluginRoutes);
  app.route('/v2/session', stateRoutes);
  app.route('/v2/session', submitInputsRoutes);
  app.route('/v2/session', messageRoutes);
  app.route('/v2/session', characterRoutes);
  app.route('/v2/events', eventRoutes);
  app.route('/v2/events', subscribeRoutes);
  app.route('/v2/runtime', runtimeRoutes);
  app.route('/v2/worlds', worldRoutes);
  app.route('/v2/health', healthRoutes);
  app.route('/actions', actionRoutes);

  return { app, registry, stateManager, store, eventBus };
}
