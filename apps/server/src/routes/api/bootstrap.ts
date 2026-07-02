/**
 * API Bootstrap — creates a fully wired Hono app with all dependencies injected.
 *
 * This module assembles the dependency graph and returns a ready-to-use app.
 * Can be used by the real server or by tests with mock dependencies.
 */

import { Hono, type MiddlewareHandler } from "hono";
import type { RuntimeManifest } from "@covel/shared";
import { readRuntimeEnv } from "@covel/shared";
import {
  loadRuntime as loadRuntimeFromDisk,
  loadPluginLlmConfig,
  deriveBuiltinPluginIds,
  type PluginRegistry,
  type LoadedRuntime,
  type PluginLlmConfig,
  type PluginRuntimeGateway,
  type PluginRuntimeUtils,
} from "@covel/plugin-loader";
import { createStateManager, type StateManager } from "@covel/state";
import { createEventBus, type EventBus } from "@covel/events";
import type { DataStore, StoreBackend } from "@covel/store";
import type { LLMAdapter } from "@covel/runtime";
import { createModelResolver } from "@covel/runtime";
import type { CompactorRunner } from "@covel/context";
import type { ToolModule } from "@covel/tools";

import {
  createInProcessSessionLock,
  type SessionLock,
} from "../../lib/session-lock.js";
import { makeErrorHandler } from "../../api-error.js";
import { sessionRoutes } from "./session.js";
import { pluginRoutes } from "./plugins.js";
import { frameworkRoutes } from "./framework.js";
import { stateRoutes } from "./state.js";
import { eventRoutes } from "./events.js";
import { createHealthRoutes } from "./health.js";
import { worldRoutes } from "./worlds.js";
import { messageRoutes } from "./messages.js";
import { characterRoutes } from "./characters.js";
import { actionRoutes, setMemorySystem } from "./actions.js";
import { subscribeRoutes } from "./subscribe.js";
import { pluginDataRoutes } from "./plugin-data.js";
import { workingMemoryRoutes } from "./working-memory.js";
import { installRoutes } from "./install.js";
import { aiRoutes } from "./ai.js";
import { traceRoutes } from "./traces.js";
import { mediaRoutes } from "./media.js";
import type { MediaStore } from "@covel/store";
import type { MediaStoreBackend, VectorBackend } from "@covel/store";
import { resumeRoutes } from "./resume.js";
import { maybeSweepExpiredSuspensions } from "./suspension-sweep.js";
import { snapshotRoutes } from "./snapshots.js";
import { lorebookRoutes } from "./lorebook.js";
import { runtimeOutputRoutes } from "./runtime-outputs.js";
import { pluginRpcRoutes } from "./plugin-rpc.js";
import { approvalRoutes, sessionApprovalRoutes } from "./approvals.js";
export { wrapStoreWithPluginDataEvents } from "./bootstrap/plugin-data-store-events.js";
import { createBootstrapCompactorRunner } from "./bootstrap/compactor.js";
import { discoverAndRegisterPlugins } from "./bootstrap/plugin-discovery.js";
import { createBootstrapHookPipeline } from "./bootstrap/plugin-hooks.js";
import { setupPluginTools } from "./bootstrap/tools.js";
import { createEventDirectory } from "./bootstrap/event-directory.js";
import { createBootstrapMemorySystem } from "./bootstrap/memory.js";
import { createBootstrapPluginRpc } from "./bootstrap/plugin-rpc-wiring.js";
import { wrapStoreWithPluginDataEvents } from "./bootstrap/plugin-data-store-events.js";

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
  /** Ordered world package directories. Later directories override earlier ones for session imports. */
  readonly worldsDirs?: readonly string[];
  /** Covel home directory for user world overrides. */
  readonly covelHome?: string;
  /** LLM adapter (real or mock). */
  readonly llmAdapter: LLMAdapter;
  /**
   * Optional narrow gateway facade exposed to function-runtime handlers
   * via `FunctionHandlerContext.gateway`. The server composition root
   * builds this from `createAiStack().gateway`; tests that don't need
   * LLM access from function runtimes can leave it out.
   */
  readonly pluginGateway?: PluginRuntimeGateway;
  /**
   * Plugin-facing utility surface (SSRF guard + retrying fetch) exposed
   * via `FunctionHandlerContext.utils`. Stateless singleton — typically
   * built from `@covel/ai-provider`'s `validateBaseUrlForPlugin` +
   * `fetchWithRetry` exports in the composition root.
   */
  readonly pluginUtils?: PluginRuntimeUtils;
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
  /**
   * Optional embedding function for the semantic (vector) memory tier. When
   * provided AND the store supports vectors, the memory system upgrades
   * recall/archival from keyword to vector search and gains a real embed-on-
   * write ingestion path. The composition root builds it from
   * `createAiStack().gateway.embed`. Absent → keyword-only memory (unchanged).
   */
  readonly memoryEmbed?: (texts: readonly string[]) => Promise<Float32Array[]>;
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
  readonly getConfigFn?: (
    pluginId: string,
    runtimeId: string,
  ) => Readonly<Record<string, unknown>>;
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
  /**
   * Optional content-addressable media store backing `/api/media/:id`
   * and `ctx.media`. Composition roots that do not generate or serve
   * media (e.g. headless test harnesses) may leave this unset; the
   * route returns 503 in that case. See SPEC §5.1 (b)(g).
   */
  readonly mediaStore?: MediaStore;
  readonly mediaBackend?: MediaStoreBackend;
  readonly vectorBackend?: VectorBackend;
}

export interface ApiBootstrapResult {
  readonly app: Hono;
  readonly registry: PluginRegistry;
  readonly stateManager: StateManager;
  readonly store: DataStore;
  readonly eventBus: EventBus;
  readonly compactorRunner: CompactorRunner;
  /**
   * Refresh the per-session tool override cache for `(create|update)-character`
   * so the next `executeTurn` exposes schema-typed `fields` to the LLM.
   * Idempotent and safe to call when no schema exists yet (it simply clears
   * the cache for that session).
   */
  readonly prepareToolsForSession: (sessionId: string) => Promise<void>;
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
export async function bootstrapApi(
  config: ApiBootstrapConfig,
): Promise<ApiBootstrapResult> {
  // 1. Create shared infrastructure first (eventBus needed by registry)
  const stateManager = config.stateManager ?? createStateManager(config.store);
  const eventBus = createEventBus(config.store);

  // Per-session serializer. The caller (e.g. `app.ts`) may inject a PG
  // advisory-lock implementation for multi-pod safety; otherwise we fall
  // back to the in-process chain lock which is correct for single-process
  // deployments (memory/sqlite, single PG pod). Route handlers read this
  // via `c.get('sessionLock')` and never import a concrete lock module.
  const sessionLock: SessionLock =
    config.sessionLock ?? createInProcessSessionLock();
  console.log(
    `[bootstrap] session lock: ${config.sessionLock ? "external (injected)" : "in-process"}`,
  );

  // Wrap store to automatically emit plugin-data.changed SSE events
  // on every setPluginData / setPluginDataBatch call, regardless of caller.
  const store = wrapStoreWithPluginDataEvents(config.store, eventBus);

  // One-time startup sweep of stale suspensions accumulated while the server
  // was down (TODO S4-T4.c). Fire-and-forget — never blocks boot.
  void maybeSweepExpiredSuspensions(store, { force: true }).catch(
    (err: unknown) =>
      console.warn(
        "[suspension-sweep] startup sweep failed:",
        err instanceof Error ? err.message : String(err),
      ),
  );

  const { registry, discoveryMap, manifestCache } =
    await discoverAndRegisterPlugins({
      pluginsDir: config.pluginsDir,
      pluginsDirs: config.pluginsDirs,
      eventBus,
    });

  // Reserved plugin IDs for install-time shadow protection — derived from the
  // bundled plugins just discovered (those tagged `source: 'builtin'`), so the
  // reservation list tracks the `plugins/` directory automatically instead of a
  // hand-edited array. Injected via middleware below and consumed by the plugin
  // install route to reject third-party packages that claim a builtin id.
  const reservedPluginIds = deriveBuiltinPluginIds(discoveryMap.values());

  // Session event directory — aggregates active plugins' `events` manifest
  // contracts (union, first-wins on cross-plugin topic conflicts) so the
  // emit-event tool below can validate emitted payloads. Re-aggregated per
  // call since session activation changes turn to turn; only compiled ajv
  // validators are cached.
  const eventDirectory = createEventDirectory({
    registry,
    resolvePluginDir: (pluginId) => discoveryMap.get(pluginId)?.rootPath,
  });

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

  // loadRuntime resolver (locale-aware: loads PLUGIN.en.md when locale is "en-US")
  const loadRuntimeFn = async (
    manifest: RuntimeManifest,
    locale?: string,
  ): Promise<LoadedRuntime | undefined> => {
    for (const [pluginId, discovery] of discoveryMap) {
      const manifests = manifestCache.get(pluginId);
      if (manifests?.some((m) => m.manifest.name === manifest.name)) {
        return loadRuntimeFromDisk(discovery, manifest.name, locale);
      }
    }
    return undefined;
  };

  // 6. Create ToolExecutor with builtin + plugin local tools + approval.
  //    Wiring extracted into `setupPluginTools` (bootstrap/tools.ts). It builds
  //    the framework tool registry, per-session character-tool overrides, and
  //    the approval-gated executor. `toolMap` / `builtinToolNames` remain
  //    mutable here so the memory system can register its tools below.
  const {
    toolMap,
    builtinToolNames,
    toolExecutor,
    prepareToolsForSession,
    activatePluginLocalTools,
  } = await setupPluginTools({
    store,
    registry,
    discoveryMap,
    manifestCache,
    llmAdapter: config.llmAdapter,
    eventDirectory,
  });

  // 6b. Eagerly load runtimes that declare UI specs so /api/ui-specs has data at boot
  for (const [pluginId] of discoveryMap) {
    const manifests = manifestCache.get(pluginId);
    if (!manifests) continue;
    for (const parsed of manifests) {
      if (parsed.manifest.ui) {
        try {
          const loaded = await loadRuntimeFn(parsed.manifest);
          if (loaded) {
            const entry = registry.get(pluginId);
            if (entry) {
              (entry.loadedRuntimes as Map<string, typeof loaded>).set(
                parsed.manifest.name,
                loaded,
              );
            }
          }
        } catch (err) {
          console.warn(
            `[bootstrap] Failed to load UI specs for ${parsed.manifest.name}:`,
            err,
          );
        }
      }
    }
  }

  // 7. getConfigFn — per-request config injection
  //    Actual config pre-loading happens in the actions.ts route handler
  //    before calling executeTurn, bridging async store reads to sync getConfig interface.
  const getConfigFn =
    config.getConfigFn ??
    ((
      _pluginId: string,
      _runtimeId: string,
    ): Readonly<Record<string, unknown>> => ({}));
  const getPluginSource = (pluginId: string) => registry.get(pluginId)?.source;

  const { rpcRegistry, rpcExecutor, rpcApprovalGate } =
    createBootstrapPluginRpc({
      discoveryMap,
      manifestCache,
    });

  const hookPipeline = createBootstrapHookPipeline({
    discoveryMap,
    manifestCache,
  });

  const runtimeEnv = readRuntimeEnv();
  const compactorRunner = createBootstrapCompactorRunner({
    manifestCache,
    store,
    llmAdapter: config.llmAdapter,
    contextWindow: runtimeEnv.compactorContextWindow,
  });

  // 8. Create memory system (Letta-style three-tier memory)
  const bootstrapMemory = createBootstrapMemorySystem({
    manifestCache,
    store,
    llmAdapter: config.llmAdapter,
    ...(config.memoryEmbed ? { embed: config.memoryEmbed } : {}),
    preferredMemorySlot: config.preferredMemorySlot,
    resolveModel,
    // Break memoryBlocks label collisions by trust tier (builtin > official >
    // community), using the non-forgeable discovery source rather than load
    // order — keeps a community plugin from shadowing a builtin default block.
    getPluginSource,
  });
  if (bootstrapMemory) {
    for (const t of bootstrapMemory.tools) {
      toolMap.set(t.name, t);
      builtinToolNames.add(t.name);
    }
    setMemorySystem(bootstrapMemory.memorySystem);
  }

  // 9. Create app with dependency injection middleware
  const app = new Hono();

  const isDev = runtimeEnv.nodeEnv !== "production";
  app.onError(makeErrorHandler("[api] Route error", isDev));

  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("stateManager", stateManager);
    c.set("eventBus", eventBus);
    c.set("pluginRegistry", registry);
    c.set("llmAdapter", config.llmAdapter);
    if (config.pluginGateway) {
      c.set("pluginGateway", config.pluginGateway);
    }
    if (config.pluginUtils) {
      c.set("pluginUtils", config.pluginUtils);
    }
    c.set("loadRuntimeFn", loadRuntimeFn);
    c.set("toolExecutor", toolExecutor);
    c.set("getConfigFn", getConfigFn);
    c.set("resolveModel", resolveModel);
    c.set("compactorRunner", compactorRunner);
    c.set("hookPipeline", hookPipeline);
    c.set("eventDirectory", eventDirectory);
    // memorySystem injected via module-level setter, not Hono context
    c.set("rpcExecutor", rpcExecutor);
    c.set("rpcRegistry", rpcRegistry);
    c.set("rpcApprovalGate", rpcApprovalGate);
    c.set("sessionLock", sessionLock);
    c.set("prepareToolsForSession", prepareToolsForSession);
    c.set("getPluginSource", getPluginSource);
    c.set("activatePluginLocalTools", activatePluginLocalTools);
    c.set("reservedPluginIds", reservedPluginIds);
    if (config.worldsDirs) {
      c.set("worldsDirs", config.worldsDirs);
    }
    if (config.covelHome) {
      c.set("covelHome", config.covelHome);
    }
    if (config.ensureEmbeddingLock) {
      c.set("ensureEmbeddingLock", config.ensureEmbeddingLock);
    }
    if (config.mediaStore) {
      c.set("mediaStore", config.mediaStore);
    }
    c.set("builtinToolNames", [...builtinToolNames].sort());
    await next();
  });

  // Optional request-scoped middleware (e.g. per-request llmAdapter swap
  // driven by X-Provider-Keys / X-Slot-Config headers). Runs AFTER the
  // dependency-injection middleware above so it can override any value
  // that was just set by reading from c.get / c.set.
  if (config.perRequestMiddleware) {
    for (const mw of config.perRequestMiddleware) {
      app.use("*", mw);
    }
  }

  // 9. Mount routes — all under /api/ prefix
  // Session routes: frontend uses /api/sessions (plural) for all session operations
  app.route("/api/sessions", sessionRoutes);
  app.route("/api/sessions", stateRoutes);
  app.route("/api/sessions", messageRoutes);
  app.route("/api/sessions", characterRoutes);
  app.route("/api/sessions", pluginDataRoutes);
  app.route("/api/sessions", workingMemoryRoutes);
  app.route("/api/sessions", resumeRoutes); // S4-T4: suspend/resume (resume + suspensions list/delete)
  app.route("/api/sessions", snapshotRoutes); // S4-T2: state snapshots + fork
  app.route("/api/sessions", lorebookRoutes); // S3-T6: session-level lorebook viewer
  app.route("/api/sessions", runtimeOutputRoutes); // PR-1: translation-layer observability
  app.route("/api/sessions", pluginRpcRoutes); // PR-3: plugin RPC channel
  app.route("/api/sessions", sessionApprovalRoutes); // PR-7: per-session approvals listing
  app.route("/api/approvals", approvalRoutes); // PR-7: approval lookup + decision
  app.route("/api/plugins", pluginRoutes);
  app.route("/api/framework", frameworkRoutes);
  app.route("/api/events", eventRoutes);
  app.route("/api/events", subscribeRoutes);
  app.route("/api/worlds", worldRoutes);
  app.route(
    "/api/health",
    createHealthRoutes(store, config.storeBackend, {
      mediaBackend: config.mediaBackend,
      mediaStore: config.mediaStore,
      vectorBackend: config.vectorBackend,
    }),
  );
  app.route("/api/install", installRoutes);
  app.route("/api/ai", aiRoutes);
  app.route("/api/actions", actionRoutes);
  app.route("/api/traces", traceRoutes);
  app.route("/api/media", mediaRoutes); // SPEC §5.1 (g): signed-URL access to MediaStore

  return {
    app,
    registry,
    stateManager,
    store,
    eventBus,
    compactorRunner,
    prepareToolsForSession,
  };
}
