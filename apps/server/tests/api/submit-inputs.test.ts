/**
 * submit-inputs route — asserts it does NOT pollute turn_messages with
 * a synthetic assistant-role row. (Fix for 2026-04-12 audit Finding 1.)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { createMemoryStore, type DataStore } from '@covel/store';
import {
  createPluginRpcRegistry,
  createRpcExecutor,
  submitFormHandler,
} from '@covel/runtime';
import { submitInputsRoutes } from '../../src/routes/api/submit-inputs.js';

function makeApp(store: DataStore): Hono {
  const app = new Hono();
  // PR-3: route now forwards into the framework default submit-form RPC
  // handler. Tests must wire an executor into context so the dispatch finds it.
  const registry = createPluginRpcRegistry();
  registry.registerFrameworkDefault('submit-form', submitFormHandler);
  const executor = createRpcExecutor({
    registry,
    loadHandler: async () => {
      throw new Error('plugin handlers not used in this test');
    },
  });
  app.use('*', async (c, next) => {
    c.set('store', store);
    c.set('rpcExecutor', executor);
    await next();
  });
  app.route('/api/sessions', submitInputsRoutes);
  return app;
}

describe('submit-inputs route — history hygiene', () => {
  let store: DataStore;
  let app: Hono;
  const sessionId = 'sess-1';
  const turnId = 'turn-1';

  beforeEach(async () => {
    store = createMemoryStore();
    await store.createSession({
      id: sessionId,
      worldId: null,
      status: 'active',
      presetId: null,
      activePlugins: [],
      turnCount: 0,
      preGameCompleted: [],
      createdAt: new Date().toISOString(),
    });
    // Seed a template message that submit-inputs will fill. We use the legacy
    // `pendingInput: { formId }` shape because findTemplateMessage() matches
    // it against `sub.interactionId` in that branch (see submit-inputs.ts:176).
    await store.appendTurnMessage({
      id: 'msg-template',
      sessionId,
      turnId,
      sourceType: 'runtime',
      sourcePluginId: 'core-char-creator',
      role: 'assistant',
      name: 'form-template',
      content: 'Player name is {{name}}',
      order: 700,
      pendingInput: { formId: 'form-char-creation' },
      createdAt: new Date().toISOString(),
    });
    app = makeApp(store);
  });

  it('does NOT write a synthetic assistant-role row after form submission', async () => {
    const res = await app.request(`/api/sessions/${sessionId}/submit-inputs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        turnId,
        formId: 'form-char-creation',
        values: { name: 'Aria' },
      }),
    });
    expect(res.status).toBe(200);

    const rows = await store.listTurnMessages(sessionId);
    const playerInputRows = rows.filter((m) => m.sourceType === 'player-input');
    expect(playerInputRows).toHaveLength(0);
  });

  it('still returns the filled narrative in the response body', async () => {
    const res = await app.request(`/api/sessions/${sessionId}/submit-inputs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        turnId,
        formId: 'form-char-creation',
        values: { name: 'Aria' },
      }),
    });
    const body = await res.json() as { filledNarrative?: string; accepted?: boolean };
    expect(body.filledNarrative).toContain('Aria');
    expect(body.accepted).toBe(true);
  });
});
