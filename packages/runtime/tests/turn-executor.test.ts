/**
 * E2E integration test: TurnExecutor with Mock LLM.
 *
 * Verifies the complete pipeline:
 * Plugin discovery → Load → Trigger → Schedule → Context → LLM call → Result
 */

import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import type { RuntimeManifest, TurnInput } from '@covel/shared';
import { discoverPlugins, loadPluginManifest, loadRuntime } from '@covel/plugin-loader';
import type { LoadedRuntime } from '@covel/plugin-loader';
import { createMemoryStore } from '@covel/store';
import { executeTurn } from '../src/turn-executor.js';
import type { TurnExecutorDeps } from '../src/turn-executor.js';
import type { LLMAdapter, LLMResponse } from '../src/llm-adapter.js';

// ── Mock LLM ─────────────────────────────────────────────────────

class MockLLM implements LLMAdapter {
  calls: Array<{ messages: readonly { role: string; content: string }[] }> = [];
  response: LLMResponse = {
    content: '你踏入了黑暗的森林，空气中弥漫着腐叶和泥土的气息。远处传来一声低沉的吼叫，你的手不自觉地握紧了腰间的短剑。',
    toolCalls: [],
    finishReason: 'stop',
    usage: { inputTokens: 100, outputTokens: 50 },
  };

  async generate(params: { messages: readonly { role: string; content: string }[] }): Promise<LLMResponse> {
    this.calls.push({ messages: params.messages });
    return this.response;
  }
}

// ── Helpers ───────────────────────────────────────────────────────

const PLUGINS_DIR = path.resolve(
  import.meta.dirname,
  '../../../plugins',
);

function makeTurnInput(overrides?: Partial<TurnInput>): TurnInput {
  return {
    sessionId: 'sess-1',
    turnId: 'turn-1',
    playerMessage: '我走进森林',
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────

describe('TurnExecutor E2E', () => {
  let mockLLM: MockLLM;
  let narratorManifest: RuntimeManifest;
  let narratorLoaded: LoadedRuntime;

  beforeEach(async () => {
    mockLLM = new MockLLM();

    // Discover and load the core-narrator plugin
    const discoveries = await discoverPlugins(PLUGINS_DIR);
    const narratorDiscovery = discoveries.find((d) => d.id === 'core-narrator');
    expect(narratorDiscovery).toBeDefined();

    const manifests = await loadPluginManifest(narratorDiscovery!);
    expect(manifests.length).toBe(1);

    narratorManifest = manifests[0].manifest;
    narratorLoaded = {
      manifest: narratorManifest,
      promptTemplate: manifests[0].promptTemplate,
      references: [],
    };
  });

  it('should discover core-narrator from plugins/', () => {
    expect(narratorManifest.name).toBe('core-narrator');
    expect(narratorManifest.priority).toBe(500);
    expect(narratorManifest.pluginType).toBe('core-plugin');
  });

  it('should execute a turn with core-narrator and get narrative output', async () => {
    const deps: TurnExecutorDeps = {
      loadRuntime: async () => narratorLoaded,
      llm: mockLLM,
      getConfig: () => ({}),
    };

    const result = await executeTurn(
      makeTurnInput(),
      [narratorManifest],
      deps,
    );

    expect(result.turnId).toBe('turn-1');
    expect(result.sessionId).toBe('sess-1');
    expect(result.runtimeResults).toHaveLength(1);

    const narratorResult = result.runtimeResults[0];
    expect(narratorResult.status).toBe('success');
    expect(narratorResult.pluginId).toBe('core-narrator');
    expect(narratorResult.output).toBeDefined();
    expect((narratorResult.output as Record<string, unknown>).narrativeOutput).toContain('黑暗的森林');
  });

  it('should pass player message to LLM in context', async () => {
    const deps: TurnExecutorDeps = {
      loadRuntime: async () => narratorLoaded,
      llm: mockLLM,
      getConfig: () => ({}),
    };

    await executeTurn(
      makeTurnInput({ playerMessage: '我攻击巨龙' }),
      [narratorManifest],
      deps,
    );

    // Verify the LLM was called
    expect(mockLLM.calls).toHaveLength(1);

    // System prompt should contain the interpolated player message
    const systemMsg = mockLLM.calls[0].messages.find((m) => m.role === 'system');
    expect(systemMsg).toBeDefined();
    expect(systemMsg!.content).toContain('我攻击巨龙');

    // User message should also be present
    const userMsg = mockLLM.calls[0].messages.find((m) => m.role === 'user');
    expect(userMsg).toBeDefined();
    expect(userMsg!.content).toBe('我攻击巨龙');
  });

  it('should handle multiple runtimes in priority order', async () => {
    const preNarrator: RuntimeManifest = {
      name: 'pre-process',
      description: 'Pre-turn processing',
      priority: 300,
    };

    const preLoaded: LoadedRuntime = {
      manifest: preNarrator,
      promptTemplate: 'You are a pre-processor.',
      references: [],
    };

    const deps: TurnExecutorDeps = {
      loadRuntime: async (manifest) => {
        if (manifest.name === 'core-narrator') return narratorLoaded;
        if (manifest.name === 'pre-process') return preLoaded;
        return undefined;
      },
      llm: mockLLM,
      getConfig: () => ({}),
    };

    const result = await executeTurn(
      makeTurnInput(),
      [narratorManifest, preNarrator], // Deliberately out of priority order
      deps,
    );

    expect(result.runtimeResults).toHaveLength(2);

    // LLM should be called twice (once for pre-process at 300, once for narrator at 500)
    expect(mockLLM.calls).toHaveLength(2);
  });

  it('should handle LLM failure gracefully', async () => {
    const failingLLM: LLMAdapter = {
      async generate() {
        throw new Error('LLM API Error: rate limited');
      },
    };

    const deps: TurnExecutorDeps = {
      loadRuntime: async () => narratorLoaded,
      llm: failingLLM,
      getConfig: () => ({}),
    };

    const result = await executeTurn(
      makeTurnInput(),
      [narratorManifest],
      deps,
    );

    // Turn should still complete, but narrator result should be failed
    expect(result.runtimeResults).toHaveLength(1);
    expect(result.runtimeResults[0].status).toBe('failed');
    expect(result.runtimeResults[0].error).toContain('rate limited');
  });

  it('should skip runtimes that do not trigger', async () => {
    const manualRuntime: RuntimeManifest = {
      name: 'manual-only',
      description: 'Only runs when manually triggered',
      priority: 600,
      trigger: { type: 'manual' },
    };

    const deps: TurnExecutorDeps = {
      loadRuntime: async () => narratorLoaded,
      llm: mockLLM,
      getConfig: () => ({}),
    };

    const result = await executeTurn(
      makeTurnInput(),
      [narratorManifest, manualRuntime],
      deps,
    );

    // Only narrator should run (manual-only skipped because isManualTrigger is false)
    expect(result.runtimeResults).toHaveLength(1);
    expect(result.runtimeResults[0].pluginId).toBe('core-narrator');
  });

  it('should save player and runtime messages to store when store is provided', async () => {
    const store = createMemoryStore();

    const deps: TurnExecutorDeps = {
      loadRuntime: async () => narratorLoaded,
      llm: mockLLM,
      getConfig: () => ({}),
      store,
    };

    await executeTurn(
      makeTurnInput({ sessionId: 'sess-msg', playerMessage: '我走进森林' }),
      [narratorManifest],
      deps,
    );

    const messages = await store.listTurnMessages('sess-msg');

    // Should have at least 2 messages: player message + runtime output
    expect(messages.length).toBeGreaterThanOrEqual(2);

    // First message should be the player message
    const playerMsg = messages.find(m => m.sourceType === 'player');
    expect(playerMsg).toBeDefined();
    expect(playerMsg!.role).toBe('user');
    expect(playerMsg!.content).toBe('我走进森林');

    // Second message should be the runtime output
    const runtimeMsg = messages.find(m => m.sourceType === 'runtime');
    expect(runtimeMsg).toBeDefined();
    expect(runtimeMsg!.role).toBe('assistant');
    expect(runtimeMsg!.name).toBe('core-narrator');
    expect(runtimeMsg!.content).toContain('黑暗的森林');
  });

  it('should pass message history to context builder', async () => {
    const store = createMemoryStore();

    // Pre-populate store with history
    await store.appendTurnMessage({
      id: 'hist-1',
      sessionId: 'sess-hist',
      turnId: 'turn-0',
      sourceType: 'player',
      role: 'user',
      content: 'Previous player message',
      order: 0,
      createdAt: '2024-01-01T00:00:00Z',
    });
    await store.appendTurnMessage({
      id: 'hist-2',
      sessionId: 'sess-hist',
      turnId: 'turn-0',
      sourceType: 'runtime',
      sourcePluginId: 'core-narrator',
      role: 'assistant',
      name: 'core-narrator',
      content: 'Previous narrator response',
      order: 500,
      createdAt: '2024-01-01T00:00:01Z',
    });

    const deps: TurnExecutorDeps = {
      loadRuntime: async () => narratorLoaded,
      llm: mockLLM,
      getConfig: () => ({}),
      store,
    };

    await executeTurn(
      makeTurnInput({ sessionId: 'sess-hist', turnId: 'turn-1', playerMessage: '继续探索' }),
      [narratorManifest],
      deps,
    );

    // Verify LLM received history messages before current user message
    expect(mockLLM.calls).toHaveLength(1);
    const llmMessages = mockLLM.calls[0].messages;

    // Should have: system + history(user) + history(assistant) + current user
    expect(llmMessages.length).toBeGreaterThanOrEqual(4);

    // Find messages by content to verify history is included
    const historyUser = llmMessages.find(m => m.content === 'Previous player message');
    expect(historyUser).toBeDefined();
    expect(historyUser!.role).toBe('user');

    const historyAssistant = llmMessages.find(m => m.content === 'Previous narrator response');
    expect(historyAssistant).toBeDefined();
    expect(historyAssistant!.role).toBe('assistant');

    // Current user message should be last non-system message
    const currentUser = llmMessages[llmMessages.length - 1];
    expect(currentUser.role).toBe('user');
    expect(currentUser.content).toBe('继续探索');
  });
});

// ── Interaction protocol tests ──────────────────────────────────

describe('TurnExecutor _interaction protocol', () => {
  it('should detect _interaction from tool results and populate pendingInputs', async () => {
    const store = createMemoryStore();
    const discoveries = await discoverPlugins(PLUGINS_DIR);
    const charDiscovery = discoveries.find(d => d.id === 'core-char-creator')!;
    const charManifests = await loadPluginManifest(charDiscovery);
    const charManifest = charManifests[0].manifest;
    const charLoaded = await loadRuntime(charDiscovery, charManifest.name);

    // MockLLM that calls create-form (which now returns _interaction)
    const mockLLM = new MockLLM();
    let callCount = 0;
    mockLLM.generate = async (params) => {
      callCount++;
      const hasToolResult = params.messages.some(m => m.role === 'tool');
      if (hasToolResult) {
        return { content: '表单已创建', toolCalls: [], finishReason: 'stop', usage: { inputTokens: 50, outputTokens: 10 } };
      }
      return {
        content: '角色创建...',
        toolCalls: [{
          id: 'tc-1',
          name: 'create-form',
          arguments: JSON.stringify({
            formId: 'test-form',
            title: '创建角色',
            fields: [{ type: 'text', name: 'charName', label: '角色名', required: true }],
            submitLabel: '确认',
            narrativeTemplate: '你的名字是 {{charName}}。',
          }),
        }],
        finishReason: 'tool_calls',
        usage: { inputTokens: 100, outputTokens: 50 },
      };
    };

    const { createToolExecutor } = await import('../src/tool-executor.js');
    const { builtinUITools } = await import('@covel/tools');
    const toolMap = new Map();
    for (const t of builtinUITools) toolMap.set(t.name, t);

    const deps: TurnExecutorDeps = {
      loadRuntime: async () => charLoaded,
      llm: mockLLM as LLMAdapter,
      getConfig: () => ({}),
      store,
      toolExecutor: createToolExecutor({ findTool: (n) => toolMap.get(n), store }),
    };

    const result = await executeTurn(makeTurnInput(), [charManifest], deps);

    // Should have pendingInputs with the interaction protocol
    expect(result.pendingInputs).toBeDefined();
    expect(result.pendingInputs!.length).toBeGreaterThanOrEqual(1);

    const pi = result.pendingInputs![0];
    expect(pi.interaction).toBeDefined();
    expect(pi.interaction.type).toBe('form');
    expect(pi.interaction.interactionId).toBe('test-form');
    // Backward compat
    expect(pi.form).toBeDefined();
    expect((pi.form as Record<string, unknown>).interactionId).toBe('test-form');
  });
});
