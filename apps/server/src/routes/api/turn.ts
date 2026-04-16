/**
 * API Turn routes — execute player turns via TurnExecutor.
 */

import { Hono } from 'hono';
import type { RuntimeManifest } from '@covel/shared';
import type { PluginRegistry, LoadedRuntime } from '@covel/plugin-loader';
import type { LLMAdapter, ToolExecutor } from '@covel/runtime';
import { executeTurn, processRuntimeResult } from '@covel/runtime';
import { rateLimiter } from '../../middleware/rate-limit.js';
import { loadSessionConfig } from './load-session-config.js';
import type { DataStore } from '@covel/store';
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
  };
};

export const turnRoutes = new Hono<Env>();

// POST /session/:id/turn — Execute a player turn
turnRoutes.post('/:id/turn', rateLimiter({ max: 30 }), async (c) => {
  const store = c.get('store');
  const pluginRegistry = c.get('pluginRegistry');
  const llmAdapter = c.get('llmAdapter');
  const loadRuntimeFn = c.get('loadRuntimeFn');
  const resolveModel = c.get('resolveModel');
  const getConfigFn = c.get('getConfigFn');
  const toolExecutor = c.get('toolExecutor');
  const compactorRunner = c.get('compactorRunner');
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

  // Execute the turn through the full pipeline
  const result = await executeTurn(
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
      getConfig: turnGetConfig,
      store,
      toolExecutor,
      resolveModel,
      compactor: compactorRunner,
    },
  );

  // Update session turn count — derive from actual turn results to avoid
  // concurrent read-modify-write races (two parallel turns reading the same
  // stale `session.turnCount` and overwriting each other).
  const turnResults = await store.listTurnResults(sessionId);
  await store.updateSession(sessionId, {
    turnCount: turnResults.length,
    updatedAt: new Date().toISOString(),
  });

  // Process runtime results through the same commit pipeline as /api/actions.
  // Without this, turn.ts would write runtime_results but not messages/state/events,
  // leaving snapshot restore desynced from LLM history. Audit Finding 3.
  const outputKindMap = new Map<string, string>();
  for (const rt of activeRuntimes) {
    outputKindMap.set(rt.name, rt.outputKind ?? 'plugin');
  }
  for (const rr of result.runtimeResults) {
    const kind = outputKindMap.get(rr.runtimeId) ?? 'plugin';
    await processRuntimeResult(rr, store, sessionId, kind);
  }

  return c.json(result);
});

// GET /session/:id/results — Get most recent turn results
turnRoutes.get('/:id/results', async (c) => {
  const store = c.get('store');
  const sessionId = c.req.param('id');

  const turnResults = await store.listTurnResults(sessionId);
  if (turnResults.length === 0) {
    return c.json({ results: [] });
  }

  const latest = turnResults[turnResults.length - 1];
  return c.json({
    turnId: latest.turnId,
    sessionId: latest.sessionId,
    runtimeResults: latest.runtimeResults,
    durationMs: latest.durationMs,
    timestamp: latest.createdAt,
  });
});

// GET /session/:id/turns — Get turn history
turnRoutes.get('/:id/turns', async (c) => {
  const store = c.get('store');
  const sessionId = c.req.param('id');
  const limitParam = c.req.query('limit');

  let turnResults = await store.listTurnResults(sessionId);

  if (limitParam !== undefined) {
    const limit = parseInt(limitParam, 10);
    if (!Number.isNaN(limit) && limit > 0) {
      turnResults = turnResults.slice(-limit);
    }
  }

  const turns = turnResults.map((tr) => ({
    turnId: tr.turnId,
    sessionId: tr.sessionId,
    runtimeResults: tr.runtimeResults,
    durationMs: tr.durationMs,
    timestamp: tr.createdAt,
  }));

  return c.json({ turns });
});
