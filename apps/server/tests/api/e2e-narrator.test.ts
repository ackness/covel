/**
 * E2E test: Complete narrator game flow through the API.
 *
 * Flow:
 *   POST /api/sessions           → create session, activate core-narrator
 *   POST /api/sessions/:id/turn  → execute turn with narrator
 *   GET  /api/sessions/:id/results → verify narrative output
 *   GET  /api/sessions/:id/turns   → verify turn history
 */

import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import type { Hono } from 'hono';
import type { LLMAdapter, LLMResponse } from '@covel/runtime';
import { createMemoryStore } from '@covel/store';
import { bootstrapApi } from '../../src/routes/api/bootstrap.js';

// ── Mock LLM that returns narrative text ─────────────────────────

class MockNarratorLLM implements LLMAdapter {
  callCount = 0;
  lastMessages: Array<{ role: string; content: string }> = [];

  async generate(params: {
    messages: readonly { role: string; content: string }[];
  }): Promise<LLMResponse> {
    this.callCount++;
    this.lastMessages = [...params.messages];

    // Find the player message to echo back — use the LAST user turn so
    // seed messages from the turn-band bootstrap don't shadow the current
    // player action.
    const userMsgs = params.messages.filter((m) => m.role === 'user');
    const userMsg = userMsgs[userMsgs.length - 1];
    const playerAction = userMsg?.content ?? '未知操作';

    return {
      content: `你${playerAction}。空气中弥漫着潮湿的泥土气息，远处传来隐约的脚步声。你紧握手中的武器，警惕地环顾四周。一道微弱的光芒从前方的裂缝中透出，似乎在引导你前行。`,
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 200, outputTokens: 80 },
    };
  }
}

// ── Tests ─────────────────────────────────────────────────────────

describe('E2E: Narrator game flow', () => {
  let app: Hono;
  let mockLLM: MockNarratorLLM;
  let store: Awaited<ReturnType<typeof bootstrapApi>>['store'];

  const PLUGINS_DIR = path.resolve(
    import.meta.dirname,
    '../../../../plugins',
  );

  beforeAll(async () => {
    mockLLM = new MockNarratorLLM();
    const result = await bootstrapApi({
      pluginsDir: PLUGINS_DIR,
      llmAdapter: mockLLM,
      store: createMemoryStore(),
      storeBackend: 'memory',
    });
    app = result.app;
    store = result.store;

    // Activate core-narrator for all sessions globally
    result.registry.activate('core-narrator', '__global__');
  });

  /**
   * Turn-band refactor helper: priority-500 narrator only runs when
   * `turnNumber >= 1` (main loop band). A freshly created session has no
   * player messages and turnNumber starts at 0 (Pre-Game band), so tests
   * must seed one prior player message to push the scheduler into the
   * main band.
   */
  async function seedPriorPlayerMessage(sessionId: string) {
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
  }

  it('should complete a full game turn through the API', async () => {
    // 1. Create session
    const startRes = await app.request('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locale: 'zh-CN', plugins: ['core-narrator'] }),
    });
    expect(startRes.status).toBe(200);

    const session = await startRes.json() as { id: string; status: string; turnCount: number };
    expect(session.id).toBeDefined();
    expect(session.status).toBe('active');
    expect(session.turnCount).toBe(0);

    const sessionId = session.id;

    // Push the scheduler into the main loop band before the player turn.
    await seedPriorPlayerMessage(sessionId);

    // 2. Execute a turn
    const turnRes = await app.request(`/api/sessions/${sessionId}/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '走进了黑暗的森林' }),
    });
    expect(turnRes.status).toBe(200);

    const turnBody = await turnRes.json() as {
      turnId: string;
      runtimeResults: Array<{
        pluginId: string;
        status: string;
        output: { narrativeOutput?: string };
      }>;
    };

    expect(turnBody.turnId).toBeDefined();
    expect(turnBody.runtimeResults).toHaveLength(1);

    const narratorResult = turnBody.runtimeResults[0];
    expect(narratorResult.pluginId).toBe('core-narrator');
    expect(narratorResult.status).toBe('success');
    expect(narratorResult.output.narrativeOutput).toContain('走进了黑暗的森林');
    expect(narratorResult.output.narrativeOutput).toContain('泥土气息');

    // 3. Get results
    const resultsRes = await app.request(`/api/sessions/${sessionId}/results`);
    expect(resultsRes.status).toBe(200);

    const resultsBody = await resultsRes.json() as { turnId: string };
    expect(resultsBody.turnId).toBe(turnBody.turnId);

    // 4. Verify LLM was called with correct context
    expect(mockLLM.callCount).toBe(1);
    const systemMsg = mockLLM.lastMessages.find((m) => m.role === 'system');
    expect(systemMsg).toBeDefined();
    // System prompt should contain the PLUGIN.md template with player message interpolated
    expect(systemMsg!.content).toContain('叙述者');
    expect(systemMsg!.content).toContain('走进了黑暗的森林');
  });

  it('should handle multiple turns in sequence', async () => {
    // Create session
    const startRes = await app.request('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plugins: ['core-narrator'] }),
    });
    const session = await startRes.json() as { id: string };

    // Push the scheduler into the main loop band before running turns.
    await seedPriorPlayerMessage(session.id);

    // Turn 1
    const turn1Res = await app.request(`/api/sessions/${session.id}/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '拔出长剑' }),
    });
    expect(turn1Res.status).toBe(200);

    // Turn 2
    const turn2Res = await app.request(`/api/sessions/${session.id}/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '向巨龙发起攻击' }),
    });
    expect(turn2Res.status).toBe(200);

    // Get turn history
    const historyRes = await app.request(`/api/sessions/${session.id}/turns`);
    expect(historyRes.status).toBe(200);

    const historyBody = await historyRes.json() as { turns: Array<{ turnId: string }> };
    expect(historyBody.turns).toHaveLength(2);
  });

  it('should return 404 for turn on non-existent session', async () => {
    const res = await app.request('/api/sessions/nonexistent/turn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'test' }),
    });
    expect(res.status).toBe(404);
  });

  it('should list core-narrator in plugins', async () => {
    const res = await app.request('/api/plugins');
    expect(res.status).toBe(200);

    const body = await res.json() as { plugins: Array<{ id: string; pluginType: string }> };
    const narrator = body.plugins.find((p) => p.id === 'core-narrator');
    expect(narrator).toBeDefined();
    expect(narrator!.pluginType).toBe('core-plugin');
  });

  it('should health check', async () => {
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);

    const body = await res.json() as { status: string };
    expect(body.status).toBe('ok');
  });
});
