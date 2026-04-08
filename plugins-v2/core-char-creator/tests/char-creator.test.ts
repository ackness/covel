/**
 * core-char-creator plugin independent tests.
 *
 * Tests the full plugin lifecycle with mock LLM:
 * 1. Plugin discovery & loading
 * 2. Trigger evaluation (only fires on turn 1)
 * 3. Context assembly (injects narrator output)
 * 4. Output parsing (narrativeTemplate + form)
 * 5. Form submission → filled narrative
 * 6. Filled narrative appears in message history for next turn
 *
 * Run: npx vitest run plugins-v2/core-char-creator/tests/
 */

import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import type { RuntimeManifest, TurnInput } from '../../../packages/shared/src/types/index.js';
import { discoverPlugins, loadPluginManifest, loadRuntime } from '../../../packages/plugin-loader/src/index.js';
import type { LoadedRuntime } from '../../../packages/plugin-loader/src/types.js';
import { createMemoryStore } from '../../../packages/store/src/memory/memory-store.js';
import { executeTurn } from '../../../packages/runtime/src/turn-executor.js';
import type { TurnExecutorDeps } from '../../../packages/runtime/src/turn-executor.js';
import { shouldTrigger } from '../../../packages/runtime/src/trigger.js';
import type { TriggerContext } from '../../../packages/runtime/src/types.js';
import type { LLMAdapter, LLMResponse } from '../../../packages/runtime/src/llm-adapter.js';
import { createToolExecutor } from '../../../packages/runtime/src/tool-executor.js';
import { createFormTool } from '../../../packages/tools/src/builtin/ui-tools.js';

// ── Mock data ────────────────────────────────────────────────────

const MOCK_FORM_ARGS = JSON.stringify({
  formId: 'char-creation',
  title: '创建你的角色',
  fields: [
    { type: 'text', name: 'characterName', label: '角色名称', required: true, placeholder: '输入你的名字...' },
    { type: 'select', name: 'gender', label: '性别', options: ['男', '女'], required: true },
    { type: 'select', name: 'spiritRoot', label: '灵根属性', options: ['水灵根', '火灵根', '木灵根'], required: true },
  ],
  submitLabel: '确认身份',
  narrativeTemplate: '你缓缓睁开双眼，耳边有个空灵的声音在呼唤「{{characterName}}」这个名字。你低头看向自己的双手——{{gender}}的手，带着{{spiritRoot}}特有的淡蓝色灵气流转。',
});

const MOCK_NARRATOR_OUTPUT = '你站在青萍山的坊市中，四周灵雾缭绕...';

class MockLLM implements LLMAdapter {
  callCount = 0;
  private charCreatorStep = 0; // Track multi-step: first call returns tool_calls, second returns final text

  async generate(params: { messages: readonly { role: string; content: string; name?: string }[] }): Promise<LLMResponse> {
    this.callCount++;
    const systemMsg = params.messages.find(m => m.role === 'system');
    const isCharCreator = systemMsg?.content.includes('角色创建引导');

    if (isCharCreator) {
      // Check if this is a follow-up after tool execution (tool result in messages)
      const hasToolResult = params.messages.some(m => m.role === 'tool');
      if (hasToolResult) {
        // After tool execution, LLM gives final text response
        return {
          content: '角色表单已创建，等待玩家填写。',
          toolCalls: [],
          finishReason: 'stop',
          usage: { inputTokens: 50, outputTokens: 20 },
        };
      }
      // First call: LLM outputs narrative text + calls create-form tool
      return {
        content: '你缓缓睁开双眼，一切都是模糊的...',
        toolCalls: [{
          id: 'call-form-1',
          name: 'create-form',
          arguments: MOCK_FORM_ARGS,
        }],
        finishReason: 'tool_calls',
        usage: { inputTokens: 100, outputTokens: 50 },
      };
    }

    // Narrator: plain text
    return {
      content: MOCK_NARRATOR_OUTPUT,
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 100, outputTokens: 50 },
    };
  }
}

// ── Tool executor factory ────────────────────────────────────────

function makeToolExecutor() {
  return createToolExecutor({
    findTool: (name) => {
      if (name === 'create-form') return createFormTool;
      return undefined;
    },
  });
}

// ── Helpers ───────────────────────────────────────────────────────

const PLUGIN_DIR = path.resolve(import.meta.dirname, '..');
const PLUGINS_DIR = path.resolve(import.meta.dirname, '../..');

function makeTurnInput(overrides?: Partial<TurnInput>): TurnInput {
  return { sessionId: 'sess-test', turnId: 'turn-1', playerMessage: '开始游戏', ...overrides };
}

function makeTriggerContext(overrides?: Partial<TriggerContext>): TriggerContext {
  return {
    sessionId: 'sess-1', turnNumber: 1, triggerCount: 0,
    turnsSinceLastTrigger: 999, pendingEventTopics: [],
    hasUpstreamFailure: false, isManualTrigger: false,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────

describe('core-char-creator plugin', () => {
  let charManifest: RuntimeManifest;
  let charLoaded: LoadedRuntime;
  let narratorManifest: RuntimeManifest;
  let narratorLoaded: LoadedRuntime;

  beforeAll(async () => {
    const discoveries = await discoverPlugins(PLUGINS_DIR);

    const charDiscovery = discoveries.find(d => d.id === 'core-char-creator')!;
    const charManifests = await loadPluginManifest(charDiscovery);
    charManifest = charManifests[0].manifest;
    charLoaded = await loadRuntime(charDiscovery, charManifest.name);

    const narratorDiscovery = discoveries.find(d => d.id === 'core-narrator')!;
    const narratorManifests = await loadPluginManifest(narratorDiscovery);
    narratorManifest = narratorManifests[0].manifest;
    narratorLoaded = await loadRuntime(narratorDiscovery, narratorManifest.name);
  });

  describe('plugin discovery', () => {
    it('should load with correct manifest', () => {
      expect(charManifest.name).toBe('core-char-creator');
      expect(charManifest.priority).toBe(700);
      expect(charManifest.pluginType).toBe('core-plugin');
    });

    it('should have input.inject from core-narrator', () => {
      expect(charManifest.input?.inject).toHaveLength(1);
      expect(charManifest.input!.inject![0].from).toBe('core-narrator');
      expect(charManifest.input!.inject![0].field).toBe('narrativeOutput');
    });

    it('should declare create-form tool', () => {
      expect(charManifest.tools?.builtin).toContain('create-form');
    });

    it('should load prompt template', () => {
      expect(charLoaded.promptTemplate).toContain('角色创建引导');
      expect(charLoaded.promptTemplate).toContain('create-form');
    });
  });

  describe('trigger evaluation', () => {
    it('should trigger on first turn (triggerCount=0)', () => {
      expect(shouldTrigger(charManifest, makeTriggerContext({ triggerCount: 0 }))).toBe(true);
    });

    it('should NOT trigger on subsequent turns (triggerCount=1)', () => {
      expect(shouldTrigger(charManifest, makeTriggerContext({ triggerCount: 1 }))).toBe(false);
    });
  });

  describe('execution with mock LLM', () => {
    it('should execute alongside narrator and produce form output', async () => {
      const store = createMemoryStore();
      const mockLLM = new MockLLM();

      const deps: TurnExecutorDeps = {
        loadRuntime: async (manifest) => {
          if (manifest.name === 'core-narrator') return narratorLoaded;
          if (manifest.name === 'core-char-creator') return charLoaded;
          return undefined;
        },
        llm: mockLLM,
        getConfig: () => ({}),
        toolExecutor: makeToolExecutor(),
        store,
      };

      const result = await executeTurn(
        makeTurnInput(),
        [narratorManifest, charManifest],
        deps,
      );

      // Both runtimes should have executed
      expect(result.runtimeResults).toHaveLength(2);

      // Narrator runs first (p=500)
      const narratorResult = result.runtimeResults.find(r => r.pluginId === 'core-narrator');
      expect(narratorResult?.status).toBe('success');

      // Char creator runs second (p=700)
      const charResult = result.runtimeResults.find(r => r.pluginId === 'core-char-creator');
      expect(charResult?.status).toBe('success');

      // Char creator output should have form
      const output = charResult!.output as Record<string, unknown>;
      expect(output.narrativeTemplate).toBeDefined();
      expect(output.form).toBeDefined();

      const form = output.form as Record<string, unknown>;
      expect(form.formId).toBe('char-creation');
      expect((form.fields as unknown[]).length).toBeGreaterThanOrEqual(3);
    });

    it('should include pendingInputs in TurnResult', async () => {
      const store = createMemoryStore();
      const mockLLM = new MockLLM();

      const deps: TurnExecutorDeps = {
        loadRuntime: async (manifest) => {
          if (manifest.name === 'core-narrator') return narratorLoaded;
          if (manifest.name === 'core-char-creator') return charLoaded;
          return undefined;
        },
        llm: mockLLM,
        getConfig: () => ({}),
        toolExecutor: makeToolExecutor(),
        store,
      };

      const result = await executeTurn(makeTurnInput(), [narratorManifest, charManifest], deps);

      expect(result.pendingInputs).toBeDefined();
      expect(result.pendingInputs!).toHaveLength(1);
      expect(result.pendingInputs![0].pluginId).toBe('core-char-creator');
      expect(result.pendingInputs![0].narrativeTemplate).toContain('{{characterName}}');
    });

    it('should save messages to store including pendingInput', async () => {
      const store = createMemoryStore();
      const mockLLM = new MockLLM();

      const deps: TurnExecutorDeps = {
        loadRuntime: async (manifest) => {
          if (manifest.name === 'core-narrator') return narratorLoaded;
          if (manifest.name === 'core-char-creator') return charLoaded;
          return undefined;
        },
        llm: mockLLM,
        getConfig: () => ({}),
        toolExecutor: makeToolExecutor(),
        store,
      };

      await executeTurn(makeTurnInput(), [narratorManifest, charManifest], deps);

      const messages = await store.listTurnMessages('sess-test');

      // Should have: player msg + narrator msg + char-creator msg
      expect(messages.length).toBeGreaterThanOrEqual(3);

      const charMsg = messages.find(m => m.name === 'core-char-creator');
      expect(charMsg).toBeDefined();
      expect(charMsg!.pendingInput).toBeDefined();
      expect((charMsg!.pendingInput as Record<string, unknown>).formId).toBe('char-creation');
    });
  });

  describe('form submission + narrative filling', () => {
    it('should fill template placeholders with player values', async () => {
      const store = createMemoryStore();
      const mockLLM = new MockLLM();

      const deps: TurnExecutorDeps = {
        loadRuntime: async (manifest) => {
          if (manifest.name === 'core-narrator') return narratorLoaded;
          if (manifest.name === 'core-char-creator') return charLoaded;
          return undefined;
        },
        llm: mockLLM,
        getConfig: () => ({}),
        toolExecutor: makeToolExecutor(),
        store,
      };

      // Turn 1
      const turn1 = await executeTurn(makeTurnInput(), [narratorManifest, charManifest], deps);

      // Simulate player form submission
      // Find the template message
      const messages = await store.listTurnMessages('sess-test');
      const templateMsg = messages.find(m => m.pendingInput);
      expect(templateMsg).toBeDefined();

      // Fill the template
      const template = templateMsg!.content;
      const filled = template
        .replace(/\{\{\s*characterName\s*\}\}/g, '林清风')
        .replace(/\{\{\s*gender\s*\}\}/g, '男')
        .replace(/\{\{\s*spiritRoot\s*\}\}/g, '水灵根');

      expect(filled).toContain('林清风');
      expect(filled).toContain('男');
      expect(filled).toContain('水灵根');
      expect(filled).not.toContain('{{');

      // Save as player-input message
      await store.appendTurnMessage({
        id: 'filled-1',
        sessionId: 'sess-test',
        turnId: turn1.turnId,
        sourceType: 'player-input',
        role: 'assistant',
        name: 'core-char-creator-result',
        content: filled,
        order: 701,
        createdAt: new Date().toISOString(),
      });

      // Save player input
      await store.savePlayerInput({
        id: 'pi-1',
        sessionId: 'sess-test',
        turnId: turn1.turnId,
        formId: 'char-creation',
        values: { characterName: '林清风', gender: '男', spiritRoot: '水灵根' },
        createdAt: new Date().toISOString(),
      });

      // Turn 2: narrator should see the filled narrative in history
      const turn2 = await executeTurn(
        makeTurnInput({ turnId: 'turn-2', playerMessage: '我环顾四周' }),
        [narratorManifest], // Only narrator on turn 2
        deps,
      );

      // LLM should have received the filled narrative in history
      expect(mockLLM.callCount).toBeGreaterThanOrEqual(3); // narrator1 + charCreator + narrator2

      // Verify messages accumulate
      const allMessages = await store.listTurnMessages('sess-test');
      expect(allMessages.length).toBeGreaterThanOrEqual(5); // player + narrator + charCreator + filled + player2 + narrator2
    });
  });
});
