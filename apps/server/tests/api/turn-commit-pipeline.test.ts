/**
 * POST /api/sessions/:id/turn — commit pipeline regression test.
 *
 * Followup for 2026-04-12 audit Finding 3 / Task 4: turn.ts now calls
 * processRuntimeResult() so that runtime narrative output is committed
 * to the messages table (used by snapshot restore), not just the
 * runtime_results table.
 *
 * Before the fix: turn route returns the result, but messages table is empty.
 * After the fix: messages table contains the runtime's narrative.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { createMemoryStore, type DataStore } from '@covel/store';
import {
  createPluginRegistry,
  type PluginRegistry,
  type PluginRegistryEntry,
  type PluginSummary,
} from '@covel/plugin-loader';
import type { RuntimeManifest } from '@covel/shared';
import type { LoadedRuntime } from '@covel/plugin-loader';
import { turnRoutes } from '../../src/routes/api/turn.js';
import { makeFakeLLM, makeFakeLoadedRuntime } from './__helpers/fake-llm.js';

// ── Test app factory ─────────────────────────────────────────────

function makeSummary(overrides: Partial<PluginSummary> = {}): PluginSummary {
  return {
    id: 'test-runtime',
    name: 'Test Runtime',
    description: '',
    pluginType: 'plugin',
    runtimeCount: 1,
    ...overrides,
  };
}

function makeEntry(args: {
  id: string;
  loaded: LoadedRuntime;
}): PluginRegistryEntry {
  // ParsedPluginMd shape — getActiveRuntimes() reads `entry.manifest.manifest`
  // (or `entry.manifests[].manifest`) to find runtimes, NOT `loadedRuntimes`.
  const parsed = {
    manifest: args.loaded.manifest,
    promptTemplate: args.loaded.promptTemplate,
    referenceLinks: [],
    rawFrontmatter: {},
  };
  return {
    id: args.id,
    summary: makeSummary({ id: args.id, name: args.id }),
    manifest: parsed,
    manifests: [parsed],
    loadedRuntimes: new Map([[args.loaded.manifest.name, args.loaded]]),
    status: 'registered',
  } as PluginRegistryEntry;
}

function createTestApp(args: {
  store: DataStore;
  registry: PluginRegistry;
  loadedRuntime: LoadedRuntime;
  llm: { generate: (...a: unknown[]) => Promise<unknown> };
}): Hono {
  const app = new Hono();
  const loadRuntimeFn = async (manifest: RuntimeManifest) => {
    return manifest.name === args.loadedRuntime.manifest.name
      ? args.loadedRuntime
      : undefined;
  };
  app.use('*', async (c, next) => {
    c.set('store', args.store);
    c.set('pluginRegistry', args.registry);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    c.set('llmAdapter', args.llm as any);
    c.set('loadRuntimeFn', loadRuntimeFn);
    await next();
  });
  app.route('/api/sessions', turnRoutes);
  return app;
}

// ── Tests ────────────────────────────────────────────────────────

describe('POST /api/sessions/:id/turn — commit pipeline (Finding 3 regression)', () => {
  let store: DataStore;
  let registry: PluginRegistry;
  let app: Hono;
  const sessionId = 'sess-1';
  const RUNTIME_ID = 'fake-narrator';
  const NARRATIVE = 'The torch flickers as the corridor opens.';

  beforeEach(async () => {
    store = createMemoryStore();
    registry = createPluginRegistry();

    const loaded = makeFakeLoadedRuntime({
      name: RUNTIME_ID,
      pluginId: RUNTIME_ID,
      outputKind: 'story',
    });
    registry.register(makeEntry({ id: RUNTIME_ID, loaded }));

    await store.createSession({
      id: sessionId,
      worldId: null,
      status: 'active',
      preGameCompleted: [],
      presetId: null,
      activePlugins: [RUNTIME_ID],
      turnCount: 1,
      createdAt: new Date().toISOString(),
    });

    // Turn-band refactor: narrator at priority 500 only runs in the main loop
    // band (turnNumber >= 1). Seed a prior player message so the next call
    // computes turnNumber = 1 and the narrator is in-band.
    await store.appendTurnMessage({
      id: crypto.randomUUID(),
      sessionId,
      turnId: 'pre-turn',
      sourceType: 'player',
      role: 'user',
      content: 'session opener',
      order: 0,
      createdAt: new Date().toISOString(),
    });

    const { llm } = makeFakeLLM(NARRATIVE);
    app = createTestApp({ store, registry, loadedRuntime: loaded, llm });
  });

  it('writes the runtime narrative into the messages table after the turn', async () => {
    const before = await store.listMessages(sessionId);
    expect(before).toHaveLength(0);

    const res = await app.request(`/api/sessions/${sessionId}/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'go forward' }),
    });
    expect(res.status).toBe(200);

    const after = await store.listMessages(sessionId);
    // processRuntimeResult should have committed at least one assistant message
    // containing the narrative.
    const assistantNarratives = after.filter(
      (m) => m.role === 'assistant' && m.content.includes(NARRATIVE),
    );
    expect(assistantNarratives.length).toBeGreaterThanOrEqual(1);
  });

  it('still updates session.turnCount as before', async () => {
    // turn.ts derives turnCount from `listTurnResults(sessionId).length` after
    // the turn commits — one executed turn → turnCount = 1.
    const turnsBefore = await store.listTurnResults(sessionId);
    expect(turnsBefore).toHaveLength(0);

    await app.request(`/api/sessions/${sessionId}/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'inspect the door' }),
    });

    const after = await store.getSession(sessionId);
    expect(after?.turnCount).toBe(1);
  });
});
