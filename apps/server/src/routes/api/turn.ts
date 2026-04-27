/**
 * API Turn routes — execute player turns via TurnExecutor.
 */

import { Hono } from 'hono';
import type { RuntimeManifest } from '@covel/shared';
import type { PluginRegistry, LoadedRuntime } from '@covel/plugin-loader';
import type { LLMAdapter, ToolExecutor, HookPipeline } from '@covel/runtime';
import { executeTurn, processRuntimeResult, createTurnEmitter } from '@covel/runtime';
import type { EventBus } from '@covel/events';
import { rateLimiter } from '../../middleware/rate-limit.js';
import { loadSessionConfig } from './load-session-config.js';
import type { DataStore, MediaStore } from '@covel/store';
import type { CompactorRunner } from '@covel/context';

type Env = {
  Variables: {
    store: DataStore;
    pluginRegistry: PluginRegistry;
    llmAdapter: LLMAdapter;
    loadRuntimeFn: (manifest: RuntimeManifest, locale?: string) => Promise<LoadedRuntime | undefined>;
    toolExecutor?: ToolExecutor;
    resolveModel?: (manifest: RuntimeManifest, apiOverride?: string) => string | undefined;
    getConfigFn?: (pluginId: string, runtimeId: string) => Readonly<Record<string, unknown>>;
    compactorRunner?: CompactorRunner;
    hookPipeline?: HookPipeline;
    eventBus?: EventBus;
    prepareToolsForSession?: (sessionId: string) => Promise<void>;
    mediaStore?: MediaStore;
  };
};

export const turnRoutes = new Hono<Env>();

// POST /session/:id/turn — Execute a player turn
turnRoutes.post('/:id/turn', rateLimiter({ max: 30 }), async (c) => {
  const store = c.get('store');
  const pluginRegistry = c.get('pluginRegistry');
  const llmAdapter = c.get('llmAdapter');
  const pluginGateway = c.get('pluginGateway');
  const pluginUtils = c.get('pluginUtils');
  const loadRuntimeFn = c.get('loadRuntimeFn');
  const resolveModel = c.get('resolveModel');
  const getConfigFn = c.get('getConfigFn');
  const toolExecutor = c.get('toolExecutor');
  const compactorRunner = c.get('compactorRunner');
  const mediaStore = c.get('mediaStore');
  const sessionId = c.req.param('id');

  const session = await store.getSession(sessionId);
  if (!session) {
    return c.json({ error: `Session "${sessionId}" not found` }, 404);
  }

  const body = await c.req.json<{ message: string; locale?: string; model?: string }>();
  const turnId = crypto.randomUUID();

  // Ensure session's plugins are activated in the registry (idempotent, needed after server restart)
  const sessionPlugins = session.activePlugins as readonly string[] | undefined;
  if (sessionPlugins) {
    for (const pid of sessionPlugins) {
      pluginRegistry.activate(pid, sessionId);
    }
  }

  // Get active runtimes for this session (sorted by priority)
  const activeRuntimes = pluginRegistry.getActiveRuntimes(sessionId);

  // Discover the world data provider plugin by capability (framework never hardcodes plugin IDs)
  const worldDataPluginId = pluginRegistry.findPluginByCapability(sessionId, 'world-data-provider');

  // Pre-load plugin config data for context injection (async → sync bridge)
  const sessionConfig = await loadSessionConfig(store, sessionId, session.worldId ?? undefined, worldDataPluginId);
  const turnGetConfig = (_pluginId: string, _runtimeId: string): Readonly<Record<string, unknown>> => sessionConfig;

  const hookPipeline = c.get('hookPipeline');
  const eventBus = c.get('eventBus');
  const sessionLock = c.get('sessionLock');
  const prepareToolsForSession = c.get('prepareToolsForSession');  // optional — see env.d.ts

  // Per-turn trace emitter — fans emit() into trace_events + eventBus. Mirrors
  // the actions.ts wiring so turn.ts also feeds the /debug timeline with
  // tool / llm / message / block / state / hook events. Without this, routes
  // that exercise `processRuntimeResult` here would silently drop the
  // fine-grained trace rows introduced in the debug-trace-expansion work.
  const emitter = createTurnEmitter({
    store,
    ...(eventBus ? { eventBus } : {}),
    sessionId,
    turnId,
  });

  // Refresh per-session character-tool overrides so the LLM sees a
  // schema-aware `fields` shape when invoking create/update-character.
  // Idempotent and a no-op when no schema is defined yet; optional-chain
  // keeps tests with hand-built DI middleware working.
  await prepareToolsForSession?.(sessionId);

  // Execute the full turn pipeline under the session lock. Without this,
  // two concurrent POST /:id/turn requests could interleave their
  // `listTurnResults().length`-based turnCount update, duplicate commit
  // writes, and fire the same hooks twice. The actions SSE route already
  // serializes on the same lock; wrapping here keeps the two entry points
  // consistent and makes PG-backed multi-pod deployments safe (audit
  // 2026-04-21 F5).
  const result = await sessionLock.withLock(sessionId, async () => {
    // Sprint 1-D: pass `worldDataPluginId` into deps so `TurnExecutor` can
    // build a unified `SessionContextSnapshot` when `COVEL_SESSION_CONTEXT=1`.
    // When the flag is off, the field is ignored and the legacy scattered
    // loads run unchanged.
    const executed = await executeTurn(
      {
        sessionId,
        turnId,
        playerMessage: body.message,
        locale: body.locale,
        modelOverride: body.model, // API-level model override
      },
      activeRuntimes,
      {
        loadRuntime: loadRuntimeFn,
        llm: llmAdapter,
        ...(pluginGateway ? { gateway: pluginGateway } : {}),
        ...(pluginUtils ? { utils: pluginUtils } : {}),
        getConfig: turnGetConfig,
        store,
        ...(mediaStore ? { mediaStore } : {}),
        toolExecutor,
        resolveModel,
        compactor: compactorRunner,
        worldDataPluginId,
        emitter,
      },
    );

    // Update session turn count — derive from actual turn results to avoid
    // concurrent read-modify-write races (two parallel turns reading the
    // same stale `session.turnCount` and overwriting each other).
    const turnResults = await store.listTurnResults(sessionId);
    await store.updateSession(sessionId, {
      turnCount: turnResults.length,
      updatedAt: new Date().toISOString(),
    });

    // Process runtime results through the same commit pipeline as
    // /api/actions. Without this, turn.ts would write runtime_results but
    // not messages/state/events, leaving snapshot restore desynced from
    // LLM history. Audit Finding 3.
    //
    // Forward hookPipeline + eventBus so PreStateCommit / PostStateCommit
    // hooks registered by plugins fire on this route too, matching
    // /api/actions.
    const outputKindMap = new Map<string, string>();
    const runtimeCapabilitiesMap = new Map<string, readonly string[]>();
    for (const rt of activeRuntimes) {
      outputKindMap.set(rt.name, rt.outputKind ?? 'plugin');
      runtimeCapabilitiesMap.set(rt.name, rt.capabilities ?? []);
    }
    for (const rr of executed.runtimeResults) {
      const kind = outputKindMap.get(rr.runtimeId) ?? 'plugin';
      const processOpts = {
        ...(hookPipeline ? { hookPipeline } : {}),
        ...(eventBus ? { eventBus } : {}),
        emitter,
        capabilities: runtimeCapabilitiesMap.get(rr.runtimeId) ?? [],
      };
      await processRuntimeResult(rr, store, sessionId, kind, processOpts);
    }

    return executed;
  });

  return c.json(result);
});

