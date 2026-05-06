import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import type { LLMAdapter, LLMResponse, LLMToolDefinition, LLMMessage } from '@covel/runtime';
import { createMemoryStore } from '@covel/store';
import { bootstrapApi } from '../../src/routes/api/bootstrap.js';
import { loadSingleWorld } from '../../src/world-seed-loader.js';

interface ActionEnvelope {
  readonly type: string;
  readonly requestId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly payload: Record<string, unknown>;
}

class ChatModeMockLLM implements LLMAdapter {
  narratorCalls = 0;
  scenePromptCalls = 0;
  readonly calls: Array<{
    readonly tools: readonly string[];
    readonly messages: readonly LLMMessage[];
  }> = [];

  async generate(params: {
    readonly messages: readonly LLMMessage[];
    readonly tools?: readonly LLMToolDefinition[];
  }): Promise<LLMResponse> {
    const toolNames = (params.tools ?? []).map((tool) => tool.name);
    this.calls.push({ tools: toolNames, messages: params.messages });

    if (toolNames.includes('generate-scene-prompts')) {
      this.scenePromptCalls += 1;
      return {
        content: null,
        toolCalls: [
          {
            id: `tc-prompts-${this.scenePromptCalls}`,
            name: 'generate-scene-prompts',
            arguments: JSON.stringify({
              scene: `二年B组 第${this.scenePromptCalls}轮`,
              prompts: [
                { kind: 'observe', text: '我看向神代澪手里的课程表' },
                { kind: 'ask', text: '我轻声问神代澪文艺部的事' },
                { kind: 'social', text: '我向朝仓凛点头打招呼' },
              ],
            }),
          },
          {
            id: `tc-done-${this.scenePromptCalls}`,
            name: 'runtime-done',
            arguments: JSON.stringify({ reason: 'scene prompts ready' }),
          },
        ],
        finishReason: 'tool_calls',
        usage: { inputTokens: 120, outputTokens: 40 },
      };
    }

    this.narratorCalls += 1;
    const userMessages = params.messages.filter((message) => message.role === 'user');
    const latestUser = userMessages.at(-1);
    const latestText = typeof latestUser?.content === 'string' ? latestUser.content : '';

    return {
      content: [
        `第${this.narratorCalls}轮：神代澪把课程表压在桌角，听见你说“${latestText}”后微微抬眼。`,
        '朝仓凛在旁边晃了晃采访本，笑着把话题推向文艺部和学园祭。',
        '教室窗外的海风掀起窗帘，澪等着你继续接话。',
      ].join(''),
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 260, outputTokens: 90 },
    };
  }
}

async function drainActionStream(res: Response): Promise<ActionEnvelope[]> {
  const envelopes: ActionEnvelope[] = [];
  if (!res.body) return envelopes;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        envelopes.push(JSON.parse(line.slice(6)) as ActionEnvelope);
      }
    }
  }

  return envelopes;
}

describe('HTTP API e2e: haruka academy chat mode', () => {
  let app: Hono;
  let mockLLM: ChatModeMockLLM;
  let store: Awaited<ReturnType<typeof bootstrapApi>>['store'];
  let registry: Awaited<ReturnType<typeof bootstrapApi>>['registry'];

  const pluginsDir = path.resolve(import.meta.dirname, '../../../../plugins');
  const worldDir = path.resolve(import.meta.dirname, '../../../../worlds/haruka-academy');

  beforeAll(async () => {
    mockLLM = new ChatModeMockLLM();
    const result = await bootstrapApi({
      pluginsDir,
      llmAdapter: mockLLM,
      store: createMemoryStore(),
      storeBackend: 'memory',
    });
    app = result.app;
    store = result.store;
    registry = result.registry;

    const world = await loadSingleWorld(worldDir);
    expect(world).toBeTruthy();
    await store.upsertWorld(world!);
  });

  it('creates a chat-mode session and completes three player rounds through /api/actions', async () => {
    const sessionId = 'sess-haruka-chat-http-e2e';
    const createRes = await app.request('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: sessionId,
        worldId: 'haruka-academy',
        locale: 'zh-CN',
        plugins: ['chat-mode-narrator'],
      }),
    });
    expect(createRes.status).toBe(200);

    const created = await createRes.json() as {
      id: string;
      activePlugins: readonly string[];
    };
    expect(created.id).toBe(sessionId);
    expect(created.activePlugins).toEqual(expect.arrayContaining([
      'chat-mode-narrator',
      'scene-cast',
      'scene-prompts',
      'character-blueprint',
    ]));
    expect(created.activePlugins).not.toContain('narrator');

    const characters = await store.listCharacters(sessionId);
    expect(characters.map((character) => character.id)).toEqual(expect.arrayContaining([
      'npc-kamishiro-mio',
      'npc-asakura-rin',
    ]));
    const mioBlueprint = await store.getPluginData(
      sessionId,
      'character-blueprint',
      'blueprints',
      'kamishiro-mio',
    );
    expect(mioBlueprint?.value).toMatchObject({
      sourceWorldId: 'haruka-academy',
      instantiatedCharacterId: 'npc-kamishiro-mio',
    });

    const now = new Date().toISOString();
    await store.upsertCharacter({
      id: 'player-haruka-e2e',
      sessionId,
      name: '藤原悠',
      type: 'player',
      description: '春季转入遥风学园二年B组的学生。',
      fields: {
        class: '二年 B 组',
        relationshipStage: '初识',
        affectionFocus: '神代澪',
      },
      version: 1,
      createdAt: now,
      updatedAt: now,
    });

    const preGameCompleted = registry
      .getActiveRuntimes(sessionId)
      .filter((runtime) => runtime.priority !== undefined && runtime.priority <= 99)
      .map((runtime) => runtime.name);
    await store.updateSession(sessionId, {
      preGameCompleted,
      turnCount: 1,
      updatedAt: now,
    });

    const inputs = [
      '神代澪，谢谢你帮我整理课程表。',
      '神代澪，文艺部今天放学后会活动吗？',
      '我看向朝仓凛，问她为什么对文艺部这么感兴趣。',
    ];
    const observedTurnIds: string[] = [];

    for (const [index, content] of inputs.entries()) {
      const actionRes = await app.request('/api/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestId: `req-haruka-chat-${index + 1}`,
          type: 'send_message',
          sessionId,
          locale: 'zh-CN',
          payload: { content },
        }),
      });
      expect(actionRes.status).toBe(200);

      const events = await drainActionStream(actionRes);
      expect(events.map((event) => event.type)).not.toContain('error.occurred');
      expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
        'execution.started',
        'runtime.completed',
        'execution.completed',
      ]));

      const turnId = events.find((event) => event.type === 'execution.started')?.turnId;
      expect(turnId).toBeDefined();
      observedTurnIds.push(turnId!);

      const runtimeRows = await store.listRuntimeResults(sessionId, turnId!);
      const successfulRuntimeIds = runtimeRows
        .filter((row) => row.status === 'success')
        .map((row) => row.runtimeId);
      expect(successfulRuntimeIds).toEqual(expect.arrayContaining([
        'scene-cast',
        'chat-mode-narrator',
        'scene-prompts',
      ]));
      const failedRows = runtimeRows.filter((row) => row.status === 'failed');
      expect(failedRows).toEqual([]);
    }

    expect(new Set(observedTurnIds).size).toBe(3);
    expect(mockLLM.narratorCalls).toBe(3);
    expect(mockLLM.scenePromptCalls).toBe(3);

    const messages = await store.listTurnMessages(sessionId);
    const storyMessages = messages.filter(
      (message) => message.sourceRuntimeId === 'chat-mode-narrator',
    );
    expect(storyMessages).toHaveLength(3);
    expect(storyMessages.at(-1)?.content).toContain('朝仓凛');

    const promptTurn = await store.getPluginData(sessionId, 'scene-prompts', 'message', '__turnId');
    const promptScene = await store.getPluginData(sessionId, 'scene-prompts', 'message', 'scene');
    const promptText = await store.getPluginData(sessionId, 'scene-prompts', 'message', 'prompt1Text');
    expect(promptTurn?.value).toBe(observedTurnIds.at(-1));
    expect(promptScene?.value).toBe('二年B组 第3轮');
    expect(promptText?.value).toContain('神代澪');

    const finalSession = await store.getSession(sessionId);
    expect(finalSession?.turnCount).toBe(3);
  });
});
