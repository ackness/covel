/**
 * API Bootstrap — creates a fully wired Hono app with all dependencies injected.
 *
 * This module assembles the dependency graph and returns a ready-to-use app.
 * Can be used by the real server or by tests with mock dependencies.
 */

import path from 'node:path';
import fsSync from 'node:fs';
import { Hono, type MiddlewareHandler } from 'hono';
import type { RuntimeManifest } from '@covel/shared';
import {
  createPluginRegistry,
  discoverPluginsMulti,
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
import type { DataStore, StoreBackend } from '@covel/store';
import type { LLMAdapter, ToolExecutor, HookPipeline, PluginHookSource } from '@covel/runtime';
import {
  createToolExecutor,
  createModelResolver,
  createPluginRpcRegistry,
  createRpcExecutor,
  submitFormHandler,
  createHookPipeline,
  registerPluginHooks,
  type PluginRpcRegistry,
  type RpcExecutor,
  type RpcHandler,
} from '@covel/runtime';
import { maybeCompact, type CompactorRunner, type CompactorLLMAdapter } from '@covel/context';
import {
  builtinUITools,
  createPluginDataTools,
  createCharacterTools,
  createWorldDimensionTools,
  createMemoryTools,
  suspendTool,
  runtimeDoneTool,
  tool,
  shortId,
  shortIdBatch,
  type ToolModule,
} from '@covel/tools';
import { z } from 'zod';
import { createMemorySystem, type MemorySystem } from '@covel/memory';
import { createApprovalPipeline, createRpcApprovalGate } from '@covel/approval';
import type { PermissionRule, RpcApprovalGate } from '@covel/approval';

import type { PluginDataRecord } from '@covel/store';

import {
  createInProcessSessionLock,
  type SessionLock,
} from '../../lib/session-lock.js';
import { sessionRoutes } from './session.js';
import { turnRoutes } from './turn.js';
import { pluginRoutes } from './plugins.js';
import { stateRoutes } from './state.js';
import { eventRoutes } from './events.js';
import { createHealthRoutes } from './health.js';
import { submitInputsRoutes } from './submit-inputs.js';
import { worldRoutes } from './worlds.js';
import { messageRoutes } from './messages.js';
import { characterRoutes } from './characters.js';
import { actionRoutes, setMemorySystem } from './actions.js';
import { subscribeRoutes } from './subscribe.js';
import { pluginDataRoutes } from './plugin-data.js';
import { workingMemoryRoutes } from './working-memory.js';
import { createRoutes } from './create.js';
import { aiRoutes } from './ai.js';
import { traceRoutes } from './traces.js';
import { resumeRoutes } from './resume.js';
import { snapshotRoutes } from './snapshots.js';
import { lorebookRoutes } from './lorebook.js';
import { runtimeOutputRoutes } from './runtime-outputs.js';
import { pluginRpcRoutes } from './plugin-rpc.js';
import { approvalRoutes, sessionApprovalRoutes } from './approvals.js';

// ── Bootstrap config ─────────────────────────────────────────────

export interface ApiBootstrapConfig {
  /** Path to plugins directory (e.g., 'plugins/'). Used when `pluginsDirs` is not provided. */
  readonly pluginsDir: string;
  /**
   * Optional ordered list of plugin directories (first wins on collision).
   * When provided, overrides `pluginsDir`. Typical desktop config:
   *   [bundledPluginsDir, userPluginsDir]
   * Bundled plugins take precedence so a user plugin with the same id cannot
   * shadow a core plugin.
   */
  readonly pluginsDirs?: readonly string[];
  /** LLM adapter (real or mock). */
  readonly llmAdapter: LLMAdapter;
  /** DataStore for all persistence. */
  readonly store: DataStore;
  /**
   * Active store backend identifier (e.g. `'sqlite'`, `'pg'`, `'memory'`).
   * Used by the health route to report the actual backend in use rather
   * than re-deriving it from environment variables.
   */
  readonly storeBackend: StoreBackend;
  /**
   * Optional embedding-lock helper. When provided, route handlers that
   * begin a turn (start_session, send_message, …) call it to lazily
   * register the session's embedding model in vector_models and lock
   * the session row. No-op when the store has no vector capability or
   * no embed slot is configured.
   */
  readonly ensureEmbeddingLock?: (sessionId: string) => Promise<void>;
  /** Optional pre-created state manager. */
  readonly stateManager?: StateManager;
  /**
   * Preferred slot name for internal memory LLM work.
   *
   * The app composition root computes this from the server slot registry so
   * memory uses the same slot-id contract exposed to runtime bindings and
   * player-facing settings (`memory` → `plugin` → `story` → first text slot).
   */
  readonly preferredMemorySlot?: string;
  /** Optional config provider for injecting world context etc. into runtime execution. */
  readonly getConfigFn?: (pluginId: string, runtimeId: string) => Readonly<Record<string, unknown>>;
  /**
   * Optional per-request middleware inserted AFTER the default dependency
   * injection middleware but BEFORE route handlers execute. Intended for
   * request-scoped overrides (e.g. swapping `llmAdapter` based on headers
   * that carry browser-defined custom slots or API keys).
   */
  readonly perRequestMiddleware?: readonly MiddlewareHandler[];
  /**
   * Per-session serializer used by turn-executing routes. When omitted,
   * `bootstrapApi()` installs an in-process `Map`-based lock which is
   * correct for single-node deployments (memory/sqlite, single PG pod).
   * Multi-pod PG deployments MUST pass a distributed implementation —
   * typically `createPgAdvisorySessionLock(sql)` from
   * `../../lib/pg-session-lock.ts` — so mutual exclusion is enforced
   * across processes. See `docs/architecture-audit-followups/F5-*`.
   */
  readonly sessionLock?: SessionLock;
}

export interface ApiBootstrapResult {
  readonly app: Hono;
  readonly registry: PluginRegistry;
  readonly stateManager: StateManager;
  readonly store: DataStore;
  readonly eventBus: EventBus;
  readonly compactorRunner: CompactorRunner;
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

  // Per-session serializer. The caller (e.g. `app.ts`) may inject a PG
  // advisory-lock implementation for multi-pod safety; otherwise we fall
  // back to the in-process chain lock which is correct for single-process
  // deployments (memory/sqlite, single PG pod). Route handlers read this
  // via `c.get('sessionLock')` and never import a concrete lock module.
  const sessionLock: SessionLock = config.sessionLock ?? createInProcessSessionLock();
  console.log(
    `[bootstrap] session lock: ${config.sessionLock ? 'external (injected)' : 'in-process'}`,
  );

  // Wrap store to automatically emit plugin-data.changed SSE events
  // on every setPluginData / setPluginDataBatch call, regardless of caller.
  const store = wrapStoreWithPluginDataEvents(config.store, eventBus);

  // 2. Discover plugins
  const registry = createPluginRegistry({ eventBus });
  const pluginsDirs =
    config.pluginsDirs && config.pluginsDirs.length > 0
      ? config.pluginsDirs
      : [config.pluginsDir];
  const discoveries = await discoverPluginsMulti(pluginsDirs, (id, kept, skipped) => {
    console.warn(
      `[bootstrap] Plugin id collision: "${id}" — keeping ${kept}, ignoring ${skipped}`,
    );
  });

  // Preload and register each plugin
  const discoveryMap = new Map<string, PluginDiscoveryResult>();
  const manifestCache = new Map<string, readonly ParsedPluginMd[]>();

  for (const discovery of discoveries) {
    try {
      const summary = await loadPluginSummary(discovery);
      const manifests = await loadPluginManifest(discovery);

      discoveryMap.set(discovery.id, discovery);
      manifestCache.set(discovery.id, manifests);

      // Sanity check: `trigger.type: 'manual'` runtimes (UI-only plugins like
      // core-memory) must leave `priority` undefined so the scheduler never
      // considers them. A stray priority + manual trigger will be filtered
      // today (shouldTrigger returns isManualTrigger=false for auto flows),
      // but the combination is almost certainly a manifest typo and will
      // produce confusing behaviour if the trigger logic evolves. Warn loudly
      // so plugin authors catch it during development.
      for (const parsed of manifests) {
        const mf = parsed.manifest;
        if (mf.trigger?.type === 'manual' && typeof mf.priority === 'number') {
          console.warn(
            `[bootstrap] Runtime "${mf.name}" declares trigger.type='manual' but also sets priority=${mf.priority}. ` +
            `Manual runtimes are UI-only and should omit priority entirely — remove one of the two to keep the scheduler intent clear.`,
          );
        }
      }

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

  // Register suspend tool (S4-T4). Always registered — harmless when flag off,
  // as the sentinel just becomes a normal tool result returned to the LLM.
  toolMap.set(suspendTool.name, suspendTool);
  builtinToolNames.add(suspendTool.name);

  // Register runtime-done tool. Framework contract: agent runtimes call this
  // immediately after completing their business tool calls to exit without
  // burning an extra LLM round-trip on a terminator message. The completion
  // preamble in buildFrameworkPreamble instructs every runtime how to use it.
  toolMap.set(runtimeDoneTool.name, runtimeDoneTool);
  builtinToolNames.add(runtimeDoneTool.name);

  // Register plugin-data tools (store-bound via closure; events emitted by store proxy)
  for (const t of createPluginDataTools(store)) {
    toolMap.set(t.name, t);
    builtinToolNames.add(t.name);
  }

  // Register character management tools (writes characters table + mirrors to plugin-data).
  // The turn-band refactor removed session.phase, so the former phase.changed
  // hook no longer applies — status transitions are driven by turnCount and
  // status updates, not character creation side effects.
  for (const t of createCharacterTools(store)) {
    toolMap.set(t.name, t);
    builtinToolNames.add(t.name);
  }

  // Register world-dimension query tools so agent runtimes can fetch only the
  // fields they need instead of relying on bulk prompt injection.
  for (const t of createWorldDimensionTools(store, {
    findWorldDataPluginId: (sessionId) => registry.findPluginByCapability(sessionId, 'world-data-provider'),
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
    const trust = getPluginTrustInfo(pluginId, discovery.source);
    if (!trust.autoLoad) {
      // Community plugin — skip import(), tools registered on approval
      continue;
    }

    const manifests = manifestCache.get(pluginId);
    if (!manifests) continue;
    for (const parsed of manifests) {
      const localPaths = parsed.manifest.tools?.local ?? [];
      for (let i = 0; i < localPaths.length; i += 1) {
        const localPath = localPaths[i];
        const fullPath = path.resolve(discovery.rootPath, localPath);
        const pluginRelPath = path.relative(process.cwd(), path.join(discovery.rootPath, 'PLUGIN.md'));
        try {
          // Security: prevent path traversal outside plugin root
          const rel = path.relative(discovery.rootPath, fullPath);
          if (rel.startsWith('..') || path.isAbsolute(rel)) {
            console.warn(
              `[plugin-loader] ${pluginRelPath}: tools.local[${i}] "${localPath}" escapes the plugin root\n` +
              `Fix: Use a path relative to the plugin directory (no "../" traversal).`,
            );
            continue;
          }
          // Surface file-not-found with a targeted hint before import() emits
          // a cryptic ERR_MODULE_NOT_FOUND from Node.
          if (!fsSync.existsSync(fullPath)) {
            console.warn(
              `[plugin-loader] ${pluginRelPath}: tool file not found — ${fullPath} (declared in tools.local[${i}] as "${localPath}")\n` +
              `Fix: Create the file, or remove the entry from tools.local in PLUGIN.md.`,
            );
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
          const message = err instanceof Error ? err.message : String(err);
          console.warn(
            `[plugin-loader] ${pluginRelPath}: failed to load tools.local[${i}] "${localPath}" — ${message}\n` +
            `Fix: Ensure ${fullPath} exports a tool module (factory or ToolModule with _type: 'covel-tool').`,
          );
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

  // 7c. PR-3: Plugin RPC registry + executor.
  //
  //   - Register framework defaults (`submit-form`, `cancel`).
  //   - Register every plugin-declared rpc action discovered in PLUGIN.md.
  //   - Build the executor with a loader that imports the handler module
  //     from the plugin's root directory.
  const rpcRegistry: PluginRpcRegistry = createPluginRpcRegistry();
  rpcRegistry.registerFrameworkDefault('submit-form', submitFormHandler, {
    description: 'Persist player input submissions and fill the originating template message.',
  });
  rpcRegistry.registerFrameworkDefault(
    'framework-submit-form',
    submitFormHandler,
    {
      description: 'Alias for submit-form (explicit framework namespace).',
    },
  );
  for (const [pluginId, manifests] of manifestCache) {
    for (const parsed of manifests) {
      const rpcMap = parsed.manifest.rpc;
      if (!rpcMap) continue;
      const discovery = discoveryMap.get(pluginId);
      const trustInfo = getPluginTrustInfo(pluginId, discovery?.source);
      const trustLevel: 'builtin' | 'official' | 'community' =
        trustInfo.source === 'builtin'
          ? 'builtin'
          : trustInfo.source === 'community'
            ? 'community'
            : 'official';
      for (const [action, decl] of Object.entries(rpcMap)) {
        try {
          rpcRegistry.registerPluginAction(pluginId, action, decl, trustLevel);
        } catch (err) {
          console.warn(
            `[bootstrap] plugin-rpc registration failed for ${pluginId}::${action}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }
  }
  const rpcExecutor: RpcExecutor = createRpcExecutor({
    registry: rpcRegistry,
    loadHandler: async (pluginId, handlerPath) => {
      const discovery = discoveryMap.get(pluginId);
      if (!discovery) {
        throw new Error(`plugin "${pluginId}" not found in discovery map`);
      }
      // HIGH-1 defence-in-depth: even though the schema rejects `..` and
      // absolute paths, a future schema change or a hand-crafted manifest
      // could still produce something that escapes the plugin root. Resolve
      // and verify containment before importing.
      const rootPath = path.resolve(discovery.rootPath);
      const absPath = path.resolve(rootPath, handlerPath);
      const rootWithSep = rootPath.endsWith(path.sep) ? rootPath : rootPath + path.sep;
      if (!absPath.startsWith(rootWithSep) && absPath !== rootPath) {
        throw new Error(
          `handler path "${handlerPath}" escapes plugin root for "${pluginId}"`,
        );
      }
      const mod = (await import(absPath)) as { default?: RpcHandler };
      if (typeof mod.default !== 'function') {
        throw new Error(`handler at ${handlerPath} has no default export function`);
      }
      return mod.default;
    },
  });

  // PR-7: per-process RPC approval gate. Pending approvals + session-cached
  // pre-authorizations live in memory; they do not survive a restart and
  // are not tied to any specific store backend.
  const rpcApprovalGate: RpcApprovalGate = createRpcApprovalGate();

  // 7d. Hook pipeline — singleton per bootstrapApi() call.
  //
  //   Each plugin's PLUGIN.md may declare `hooks: [{ event, handler }]` entries
  //   pointing at a module relative to the plugin root. Delegation to
  //   `registerPluginHooks` keeps the handler-resolution / lazy-import / path
  //   traversal logic co-located with the pipeline itself (see
  //   `packages/runtime/src/hooks/register-plugin-hooks.ts`). Plugins with
  //   no hooks leave the pipeline empty.
  const hookPipeline: HookPipeline = createHookPipeline();
  const hookSources: PluginHookSource[] = [];
  for (const [pluginId, manifests] of manifestCache) {
    const discovery = discoveryMap.get(pluginId);
    if (!discovery) continue;
    for (const parsed of manifests) {
      const hooks = parsed.manifest.hooks ?? [];
      if (hooks.length === 0) continue;
      hookSources.push({
        pluginId,
        rootPath: discovery.rootPath,
        hooks,
      });
    }
  }
  const registeredHookCount = registerPluginHooks(hookPipeline, hookSources);
  if (registeredHookCount > 0) {
    console.log(
      `[bootstrap] registered ${registeredHookCount} plugin hook handler(s) across ${hookSources.length} source(s)`,
    );
  }

  // 7b. CompactorRunner (S2-T2) — wraps maybeCompact with server-level deps.
  //     Feature-gated by COVEL_COMPACTOR_V1=1 at call site (turn-executor.ts).
  //     Collects summaryFocus from ALL registered manifests (deduplicated).
  const allSummaryFocus = new Set<string>();
  for (const [, manifests] of manifestCache) {
    for (const parsed of manifests) {
      for (const section of parsed.manifest.summaryFocus ?? []) {
        allSummaryFocus.add(section);
      }
    }
  }
  const focusSections: readonly string[] = [...allSummaryFocus];

  // Simple char-based token estimator (chars/4 ≈ tokens). Good enough for
  // compactor threshold comparisons; budget tests use the same approach.
  const simpleEstimator = (text: string): number => Math.ceil(text.length / 4);

  // Default context window (32k tokens) — used when COVEL_COMPACTOR_V1 is on
  // but no finer-grained window is configured. Callers may override via env.
  const compactorContextWindow = parseInt(process.env.COVEL_COMPACTOR_CONTEXT_WINDOW ?? '32768', 10);

  // Adapt LLMAdapter to CompactorLLMAdapter (fast slot, system+user messages)
  const fastSlotLlm: CompactorLLMAdapter = {
    async complete(params) {
      const response = await config.llmAdapter.generate({
        model: 'fast',
        messages: [
          { role: 'system', content: params.systemPrompt },
          ...params.messages.map(m => ({ role: m.role as 'user', content: m.content })),
        ],
      });
      return { content: response.content ?? '' };
    },
  };

  const compactorRunner: CompactorRunner = {
    async run(sessionId, systemPromptPreview, messages) {
      await maybeCompact(sessionId, systemPromptPreview, messages, {
        store,
        estimator: simpleEstimator,
        fastSlotLlm,
        contextWindow: compactorContextWindow,
      }, {
        focusSections,
      });
    },
  };

  // 8. Create memory system (Letta-style three-tier memory)
  // When COVEL_MEMORY_V1=1, creates the full memory system with core memory
  // blocks, recall/archival search, and compaction. Slot resolution: memory → story.
  let memorySystem: MemorySystem | undefined;
  console.log(`[bootstrap] COVEL_MEMORY_V1=${process.env.COVEL_MEMORY_V1 ?? '(unset)'}`);
  if (process.env.COVEL_MEMORY_V1 === '1') {
    // Resolve which slot to use for memory LLM calls. Use slot ids here so
    // memory follows the same contract as runtime bindings and player-facing
    // settings instead of reaching into internal preset ids.
    const resolvedMemorySlot = config.preferredMemorySlot ?? 'plugin';
    console.log(`[bootstrap] Memory system using slot: ${resolvedMemorySlot}`);

    // Discover the memory-panel host plugin by capability tag instead of
    // hardcoding a specific plugin ID. Framework stays plugin-agnostic:
    // any plugin declaring `capabilities: [memory-panel]` becomes the
    // mirror target. When no such plugin is installed, mirroring is
    // skipped and core memory still works (panel updates via polling).
    let memoryPanelPluginId: string | undefined;
    for (const [pluginId, manifests] of manifestCache) {
      if (manifests.some((m) => m.manifest.capabilities?.includes('memory-panel'))) {
        memoryPanelPluginId = pluginId;
        break;
      }
    }
    if (memoryPanelPluginId) {
      console.log(`[bootstrap] Memory panel host plugin: ${memoryPanelPluginId}`);
    } else {
      console.log('[bootstrap] No plugin declares capability "memory-panel" — mirror disabled');
    }

    const memoryLlm = {
      async complete(params: { systemPrompt: string; messages: readonly { role: string; content: string }[]; model?: string }) {
        const response = await config.llmAdapter.generate({
          model: resolvedMemorySlot,
          messages: [
            { role: 'system', content: params.systemPrompt },
            ...params.messages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
          ],
        });
        return { content: response.content ?? '' };
      },
    };
    memorySystem = createMemorySystem(
      { store, llm: memoryLlm, resolveSlot: (slot: string) => resolveModel({ name: slot, model: slot } as RuntimeManifest) },
      {
        coreMemory: memoryPanelPluginId ? { pluginId: memoryPanelPluginId } : undefined,
        updater: { modelSlot: resolvedMemorySlot },
      },
    );

    // Register memory tools as builtins
    for (const t of createMemoryTools({
      recall: memorySystem.recall,
      archival: memorySystem.archival,
      blocks: memorySystem.manager,
    })) {
      toolMap.set(t.name, t);
      builtinToolNames.add(t.name);
    }

    setMemorySystem(memorySystem);
    console.log('[bootstrap] Memory system (V1) initialized — core memory blocks + recall/archival search');
  }

  // 9. Create app with dependency injection middleware
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
    c.set('compactorRunner', compactorRunner);
    c.set('hookPipeline', hookPipeline);
    // memorySystem injected via module-level setter, not Hono context
    c.set('rpcExecutor', rpcExecutor);
    c.set('rpcRegistry', rpcRegistry);
    c.set('rpcApprovalGate', rpcApprovalGate);
    c.set('sessionLock', sessionLock);
    if (config.ensureEmbeddingLock) {
      c.set('ensureEmbeddingLock', config.ensureEmbeddingLock);
    }
    await next();
  });

  // Optional request-scoped middleware (e.g. per-request llmAdapter swap
  // driven by X-Provider-Keys / X-Slot-Config headers). Runs AFTER the
  // dependency-injection middleware above so it can override any value
  // that was just set by reading from c.get / c.set.
  if (config.perRequestMiddleware) {
    for (const mw of config.perRequestMiddleware) {
      app.use('*', mw);
    }
  }

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
  app.route('/api/sessions', resumeRoutes);  // S4-T4: suspend/resume (resume + suspensions list/delete)
  app.route('/api/sessions', snapshotRoutes); // S4-T2: state snapshots + fork
  app.route('/api/sessions', lorebookRoutes); // S3-T6: session-level lorebook viewer
  app.route('/api/sessions', runtimeOutputRoutes); // PR-1: translation-layer observability
  app.route('/api/sessions', pluginRpcRoutes); // PR-3: plugin RPC channel
  app.route('/api/sessions', sessionApprovalRoutes); // PR-7: per-session approvals listing
  app.route('/api/approvals', approvalRoutes); // PR-7: approval lookup + decision
  app.route('/api/plugins', pluginRoutes);
  app.route('/api/events', eventRoutes);
  app.route('/api/events', subscribeRoutes);
  app.route('/api/worlds', worldRoutes);
  app.route('/api/health', createHealthRoutes(store, config.storeBackend));
  app.route('/api/create', createRoutes);
  app.route('/api/ai', aiRoutes);
  app.route('/api/actions', actionRoutes);
  app.route('/api/traces', traceRoutes);

  return { app, registry, stateManager, store, eventBus, compactorRunner };
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
      // The proxy is the single emission layer for plugin-data.changed.
      // Commit-chain writes and direct store writes both pass through here.
      source: 'store-proxy',
    },
    sessionId,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Wrap a DataStore with a transparent Proxy that emits a `plugin-data.changed`
 * event after every `setPluginData` / `setPluginDataBatch` / `deletePluginData`
 * call, regardless of caller (kernel commit pipeline, plugin RPC handlers,
 * plugin-local tool direct writes, admin API endpoints).
 *
 * Governance contract:
 * - Proposal-backed plugin-data writes now enter through the Session Kernel
 *   commit pipeline before the proxy emits `plugin-data.changed`.
 * - Direct store callers still receive the same event stream, so API routes,
 *   function handlers, and internal mirrors keep the existing live-update
 *   behaviour.
 * - Observability stays complete: every write produces a
 *   `plugin-data.changed` SessionEvent persisted by eventBus.persistEvent
 *   into the `events` table and pushed to `/events/stream` subscribers.
 */
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
