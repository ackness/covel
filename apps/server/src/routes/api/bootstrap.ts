/**
 * API Bootstrap — creates a fully wired Hono app with all dependencies injected.
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
  getPluginTrustInfo,
  loadPluginLlmConfig,
  type PluginRegistry,
  type LoadedRuntime,
  type PluginDiscoveryResult,
  type ParsedPluginMd,
  type PluginLlmConfig,
} from '@covel/plugin-loader';
import { createStateManager, type StateManager } from '@covel/state';
import { createEventBus, type EventBus } from '@covel/events';
import type { DataStore } from '@covel/store';
import type { LLMAdapter, ToolExecutor } from '@covel/runtime';
import { createToolExecutor, createModelResolver } from '@covel/runtime';
import { builtinUITools, createPluginDataTools, createCharacterTools, tool, shortId, shortIdBatch, type ToolModule } from '@covel/tools';
import { z } from 'zod';
import { createApprovalPipeline } from '@covel/approval';
import type { PermissionRule } from '@covel/approval';

import type { PluginDataRecord } from '@covel/store';

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
import { pluginDataRoutes } from './plugin-data.js';
import { workingMemoryRoutes } from './working-memory.js';
import { createRoutes } from './create.js';
import { aiRoutes } from './ai.js';
import { traceRoutes } from './traces.js';

// ── Bootstrap config ─────────────────────────────────────────────

export interface ApiBootstrapConfig {
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

export interface ApiBootstrapResult {
  readonly app: Hono;
  readonly registry: PluginRegistry;
  readonly stateManager: StateManager;
  readonly store: DataStore;
  readonly eventBus: EventBus;
}

// ── Bootstrap function ───────────────────────────────────────────

/**
 * Create a fully wired API Hono app.
 *
 * 1. Discover and register all plugins
 * 2. Create shared state (session store, state manager, etc.)
 * 3. Inject all dependencies into routes via middleware
 * 4. Mount all route groups
 */
export async function bootstrapApi(config: ApiBootstrapConfig): Promise<ApiBootstrapResult> {
  // 1. Create shared infrastructure first (eventBus needed by registry)
  const stateManager = config.stateManager ?? createStateManager(config.store);
  const eventBus = createEventBus(config.store);

  // Wrap store to automatically emit plugin-data.changed SSE events
  // on every setPluginData / setPluginDataBatch call, regardless of caller.
  const store = wrapStoreWithPluginDataEvents(config.store, eventBus);

  // 2. Discover plugins
  const registry = createPluginRegistry({ eventBus });
  const discoveries = await discoverPlugins(config.pluginsDir);

  // Preload and register each plugin
  const discoveryMap = new Map<string, PluginDiscoveryResult>();
  const manifestCache = new Map<string, readonly ParsedPluginMd[]>();

  for (const discovery of discoveries) {
    try {
      const summary = await loadPluginSummary(discovery);
      const manifests = await loadPluginManifest(discovery);

      discoveryMap.set(discovery.id, discovery);
      manifestCache.set(discovery.id, manifests);

      // Register with all manifests (first is primary for getActiveRuntimes)
      registry.register({
        id: discovery.id,
        summary,
        manifest: manifests[0],
        manifests,
        loadedRuntimes: new Map(),
        status: 'registered',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[bootstrap] Failed to load plugin ${discovery.id}:`, message);

      // Register as error so the frontend can display it — don't crash the whole server
      registry.register({
        id: discovery.id,
        summary: { id: discovery.id, name: discovery.id, description: '', pluginType: 'plugin', runtimeCount: 0 },
        loadedRuntimes: new Map(),
        status: 'error',
        error: message,
      });
    }
  }

  // 3. Load plugin-level llm.toml configs for model resolution
  const pluginLlmConfigs = new Map<string, PluginLlmConfig>();
  for (const [pluginId, discovery] of discoveryMap) {
    const llmConfig = await loadPluginLlmConfig(discovery.rootPath);
    if (llmConfig) {
      // Map each runtime name to its plugin's LLM config
      const manifests = manifestCache.get(pluginId);
      if (manifests) {
        for (const parsed of manifests) {
          pluginLlmConfigs.set(parsed.manifest.name, llmConfig);
        }
      }
    }
  }

  const resolveModel = createModelResolver({ pluginLlmConfigs });

  // 4. (sessionScopes was removed 2026-04-12 — see audit Finding 2:
  //     `createSessionScope` had no production caller, the map was always
  //     empty, and PATCH /api/plugins/:id/config always 404'd. Real config
  //     lives in loadSessionConfig() + plugin_data.)

  // 5. loadRuntime resolver (locale-aware: loads PLUGIN.en.md when locale is "en-US")
  const loadRuntimeFn = async (manifest: RuntimeManifest, locale?: string): Promise<LoadedRuntime | undefined> => {
    for (const [pluginId, discovery] of discoveryMap) {
      const manifests = manifestCache.get(pluginId);
      if (manifests?.some((m) => m.manifest.name === manifest.name)) {
        return loadRuntimeFromDisk(discovery, manifest.name, locale);
      }
    }
    return undefined;
  };

  // 6. Create ToolExecutor with builtin + plugin local tools + approval
  const builtinToolNames = new Set<string>();
  const localToolNames = new Set<string>();
  const toolMap = new Map<string, ToolModule>();

  for (const t of builtinUITools) {
    toolMap.set(t.name, t);
    builtinToolNames.add(t.name);
  }

  // Register plugin-data tools (store-bound via closure; events emitted by store proxy)
  for (const t of createPluginDataTools(store)) {
    toolMap.set(t.name, t);
    builtinToolNames.add(t.name);
  }

  // Register character management tools (writes characters table + mirrors to plugin-data).
  // Hook `onPhaseTransition` lets the tool emit a phase.changed event on the
  // session SSE stream after `create-character` updates session.phase. Without
  // this hook, the frontend reducer never learns about tool-driven phase
  // transitions until a page refresh. (Followup D for the 2026-04-12 audit.)
  for (const t of createCharacterTools(store, {
    onPhaseTransition: (sessionId, phase) => {
      eventBus.emit({
        id: crypto.randomUUID(),
        type: 'event',
        topic: 'session',
        payload: {
          _subType: 'phase.changed',
          phase,
        },
        sessionId,
        timestamp: new Date().toISOString(),
      });
    },
  })) {
    toolMap.set(t.name, t);
    builtinToolNames.add(t.name);
  }

  // Injection context for factory-style tools (zero-dep plugin tools)
  const toolInjection = { tool, z, shortId, shortIdBatch, store };

  // Load plugin local tools from tools/ directories
  // SECURITY: Only auto-load tools from trusted plugins (builtin/official).
  // Community plugins register metadata only; their tools are deferred until
  // explicit approval via the plugin management API.
  for (const [pluginId, discovery] of discoveryMap) {
    const trust = getPluginTrustInfo(pluginId);
    if (!trust.autoLoad) {
      // Community plugin — skip import(), tools registered on approval
      continue;
    }

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

  // Build per-plugin tool access map: pluginId → Set<toolName>
  const pluginToolAccess = new Map<string, Set<string>>();
  for (const [pluginId, manifests] of manifestCache) {
    const allowed = new Set<string>();
    for (const parsed of manifests) {
      // Builtin tools declared by this runtime
      for (const t of parsed.manifest.tools?.builtin ?? []) allowed.add(t);
      // Local tools: extract basename from path
      for (const p of parsed.manifest.tools?.local ?? []) {
        const basename = p.split('/').pop()?.replace(/\.[^.]+$/, '') ?? p;
        allowed.add(basename);
      }
    }
    pluginToolAccess.set(pluginId, allowed);
  }

  const toolExecutor = createToolExecutor({
    findTool: (name, context) => {
      // Builtin tools are always accessible
      if (builtinToolNames.has(name)) return toolMap.get(name);
      // Local tools: only accessible if declared by the calling plugin
      if (context) {
        const allowed = pluginToolAccess.get(context.pluginId);
        if (!allowed?.has(name)) return undefined; // Cross-plugin call blocked
      }
      return toolMap.get(name);
    },
    store,
    approval,
    getToolSource: (name) => {
      if (builtinToolNames.has(name)) return 'builtin';
      if (localToolNames.has(name)) return 'local';
      return 'third-party';
    },
  });

  // 6b. Eagerly load runtimes that declare UI specs so /api/ui-specs has data at boot
  for (const [pluginId, discovery] of discoveryMap) {
    const manifests = manifestCache.get(pluginId);
    if (!manifests) continue;
    for (const parsed of manifests) {
      if (parsed.manifest.ui) {
        try {
          const loaded = await loadRuntimeFn(parsed.manifest);
          if (loaded) {
            const entry = registry.get(pluginId);
            if (entry) {
              (entry.loadedRuntimes as Map<string, typeof loaded>).set(parsed.manifest.name, loaded);
            }
          }
        } catch (err) {
          console.warn(`[bootstrap] Failed to load UI specs for ${parsed.manifest.name}:`, err);
        }
      }
    }
  }

  // 7. getConfigFn — per-request config injection
  //    Actual config pre-loading happens in route handlers (actions.ts, turn.ts)
  //    before calling executeTurn, bridging async store reads to sync getConfig interface.
  const getConfigFn = config.getConfigFn ?? ((_pluginId: string, _runtimeId: string): Readonly<Record<string, unknown>> => ({}));

  // 8. Create app with dependency injection middleware
  const app = new Hono();

  const isDev = process.env.NODE_ENV !== 'production';
  app.onError((err, c) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[api] Route error:`, err);
    return c.json(
      { error: isDev ? message : 'Internal server error' },
      { status: 500 },
    );
  });

  app.use('*', async (c, next) => {
    c.set('store', store);
    c.set('stateManager', stateManager);
    c.set('eventBus', eventBus);
    c.set('pluginRegistry', registry);
    c.set('llmAdapter', config.llmAdapter);
    c.set('loadRuntimeFn', loadRuntimeFn);
    c.set('toolExecutor', toolExecutor);
    c.set('getConfigFn', getConfigFn);
    c.set('resolveModel', resolveModel);
    await next();
  });

  // 9. Mount routes — all under /api/ prefix
  // Session routes: frontend uses /api/sessions (plural) for all session operations
  app.route('/api/sessions', sessionRoutes);
  app.route('/api/sessions', turnRoutes);
  app.route('/api/sessions', stateRoutes);
  app.route('/api/sessions', submitInputsRoutes);
  app.route('/api/sessions', messageRoutes);
  app.route('/api/sessions', characterRoutes);
  app.route('/api/sessions', pluginDataRoutes);
  app.route('/api/sessions', workingMemoryRoutes);
  app.route('/api/plugins', pluginRoutes);
  app.route('/api/events', eventRoutes);
  app.route('/api/events', subscribeRoutes);
  app.route('/api/runtime', runtimeRoutes);
  app.route('/api/worlds', worldRoutes);
  app.route('/api/health', healthRoutes);
  app.route('/api/create', createRoutes);
  app.route('/api/ai', aiRoutes);
  app.route('/api/actions', actionRoutes);
  app.route('/api/traces', traceRoutes);

  return { app, registry, stateManager, store, eventBus };
}

// ── Store decorator: auto-emit plugin-data.changed events ──────

function emitPluginDataChangedEvent(
  eventBus: EventBus,
  pluginId: string,
  sessionId: string,
  changes: readonly { namespace: string; key: string; value: unknown; operation: 'set' | 'delete' }[],
): void {
  if (changes.length === 0) return;
  eventBus.emit({
    id: crypto.randomUUID(),
    type: 'event',
    topic: 'plugin',
    payload: {
      _subType: 'plugin-data.changed',
      pluginId,
      changes,
    },
    sessionId,
    timestamp: new Date().toISOString(),
  });
}

export function wrapStoreWithPluginDataEvents(baseStore: DataStore, eventBus: EventBus): DataStore {
  return new Proxy(baseStore, {
    get(target, prop, receiver) {
      if (prop === 'setPluginData') {
        return async (record: PluginDataRecord): Promise<void> => {
          await target.setPluginData(record);
          emitPluginDataChangedEvent(eventBus, record.pluginId, record.sessionId, [{
            namespace: record.namespace,
            key: record.key,
            value: record.value,
            operation: 'set',
          }]);
        };
      }

      if (prop === 'setPluginDataBatch') {
        return async (records: readonly PluginDataRecord[]): Promise<void> => {
          await target.setPluginDataBatch(records);
          // Group by pluginId to emit one event per plugin
          const byPlugin = new Map<string, { sessionId: string; changes: { namespace: string; key: string; value: unknown; operation: 'set' | 'delete' }[] }>();
          for (const r of records) {
            let entry = byPlugin.get(r.pluginId);
            if (!entry) {
              entry = { sessionId: r.sessionId, changes: [] };
              byPlugin.set(r.pluginId, entry);
            }
            entry.changes.push({
              namespace: r.namespace,
              key: r.key,
              value: r.value,
              operation: 'set',
            });
          }
          for (const [pluginId, { sessionId, changes }] of byPlugin) {
            emitPluginDataChangedEvent(eventBus, pluginId, sessionId, changes);
          }
        };
      }

      if (prop === 'deletePluginData') {
        return async (sessionId: string, pluginId: string, namespace: string, key: string): Promise<void> => {
          await target.deletePluginData(sessionId, pluginId, namespace, key);
          emitPluginDataChangedEvent(eventBus, pluginId, sessionId, [{
            namespace,
            key,
            value: null,
            operation: 'delete',
          }]);
        };
      }

      return Reflect.get(target, prop, receiver);
    },
  });
}
