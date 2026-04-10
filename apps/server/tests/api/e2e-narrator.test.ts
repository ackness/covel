/**
 * E2E test: Complete narrator game flow through V2 API.
 *
 * Flow:
 *   POST /api/session/start → create session, activate core-narrator
 *   POST /api/session/:id/turn → execute turn with narrator
 *   GET /api/session/:id/results → verify narrative output
 *   GET /api/session/:id/turns → verify turn history
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

    // Find the player message to echo back in the narrative
    const userMsg = params.messages.find((m) => m.role === 'user');
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

describe('E2E: Narrator game flow via V2 API', () => {
  let app: Hono;
  let mockLLM: MockNarratorLLM;

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
    });
    app = result.app;

    // Activate core-narrator for all sessions globally
    result.registry.activate('core-narrator', '__global__');
  });

  it('should complete a full game turn through the API', async () => {
    // 1. Start session
    const startRes = await app.request('/api/session/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locale: 'zh-CN', plugins: ['core-narrator'] }),
    });
    expect(startRes.status).toBe(200);

    const startBody = await startRes.json() as { sessionId: string; phase: string };
    expect(startBody.sessionId).toBeDefined();
    expect(startBody.phase).toBe('pre-game');

    const sessionId = startBody.sessionId;

    // 2. Execute a turn
    const turnRes = await app.request(`/api/session/${sessionId}/turn`, {
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
    const resultsRes = await app.request(`/api/session/${sessionId}/results`);
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
    // Start session
    const startRes = await app.request('/api/session/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plugins: ['core-narrator'] }),
    });
    const { sessionId } = await startRes.json() as { sessionId: string };

    // Turn 1
    const turn1Res = await app.request(`/api/session/${sessionId}/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '拔出长剑' }),
    });
    expect(turn1Res.status).toBe(200);

    // Turn 2
    const turn2Res = await app.request(`/api/session/${sessionId}/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '向巨龙发起攻击' }),
    });
    expect(turn2Res.status).toBe(200);

    // Get turn history
    const historyRes = await app.request(`/api/session/${sessionId}/turns`);
    expect(historyRes.status).toBe(200);

    const historyBody = await historyRes.json() as { turns: Array<{ turnId: string }> };
    expect(historyBody.turns).toHaveLength(2);
  });

  it('should return 404 for turn on non-existent session', async () => {
    const res = await app.request('/api/session/nonexistent/turn', {
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
