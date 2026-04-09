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
 * Run: npx vitest run plugins/core-char-creator/tests/
 */

import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { discoverPlugins, loadPluginManifest, loadRuntime } from '@covel/plugin-loader';
import { createMemoryStore } from '@covel/store';
import { executeTurn, shouldTrigger, createToolExecutor } from '@covel/runtime';
import { createFormTool } from '@covel/tools';
import { makeTurnInput, makeTriggerContext } from '@covel/plugin-test-utils';

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

class MockLLM {
  callCount = 0;

  async generate(params) {
    this.callCount++;
    const systemMsg = params.messages.find(m => m.role === 'system');
    const isCharCreator = systemMsg?.content.includes('角色创建引导');

    if (isCharCreator) {
      const hasToolResult = params.messages.some(m => m.role === 'tool');
      if (hasToolResult) {
        return {
          content: '角色表单已创建，等待玩家填写。',
          toolCalls: [],
          finishReason: 'stop',
          usage: { inputTokens: 50, outputTokens: 20 },
        };
      }
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

    return {
      content: MOCK_NARRATOR_OUTPUT,
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 100, outputTokens: 50 },
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────

const PLUGINS_DIR = path.resolve(import.meta.dirname, '../..');

function makeToolExecutor() {
  return createToolExecutor({
    findTool: (name) => {
      if (name === 'create-form') return createFormTool;
      return undefined;
    },
  });
}

// ── Tests ─────────────────────────────────────────────────────────

describe('core-char-creator plugin', () => {
  let charManifest;
  let charLoaded;
  let narratorManifest;
  let narratorLoaded;

  beforeAll(async () => {
    const discoveries = await discoverPlugins(PLUGINS_DIR);

    const charDiscovery = discoveries.find(d => d.id === 'core-char-creator');
    const charManifests = await loadPluginManifest(charDiscovery);
    charManifest = charManifests[0].manifest;
    charLoaded = await loadRuntime(charDiscovery, charManifest.name);

    const narratorDiscovery = discoveries.find(d => d.id === 'core-narrator');
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
      expect(charManifest.input.inject[0].from).toBe('core-narrator');
      expect(charManifest.input.inject[0].field).toBe('narrativeOutput');
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

      const deps = {
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

      expect(result.runtimeResults).toHaveLength(2);

      const narratorResult = result.runtimeResults.find(r => r.pluginId === 'core-narrator');
      expect(narratorResult?.status).toBe('success');

      const charResult = result.runtimeResults.find(r => r.pluginId === 'core-char-creator');
      expect(charResult?.status).toBe('success');

      const output = charResult.output;
      expect(output.narrativeTemplate).toBeDefined();
      expect(output.form).toBeDefined();
      expect(output.form.formId).toBe('char-creation');
      expect(output.form.fields.length).toBeGreaterThanOrEqual(3);
    });

    it('should include pendingInputs in TurnResult', async () => {
      const store = createMemoryStore();
      const mockLLM = new MockLLM();

      const deps = {
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
      expect(result.pendingInputs).toHaveLength(1);
      expect(result.pendingInputs[0].pluginId).toBe('core-char-creator');
      expect(result.pendingInputs[0].narrativeTemplate).toContain('{{characterName}}');
    });

    it('should save messages to store including pendingInput', async () => {
      const store = createMemoryStore();
      const mockLLM = new MockLLM();

      const deps = {
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
      expect(messages.length).toBeGreaterThanOrEqual(3);

      const charMsg = messages.find(m => m.name === 'core-char-creator');
      expect(charMsg).toBeDefined();
      expect(charMsg.pendingInput).toBeDefined();
      const pi = charMsg.pendingInput;
      expect(Array.isArray(pi)).toBe(true);
      expect(pi[0].interactionId).toBe('char-creation');
    });
  });

  describe('form submission + narrative filling', () => {
    it('should fill template placeholders with player values', async () => {
      const store = createMemoryStore();
      const mockLLM = new MockLLM();

      const deps = {
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

      const turn1 = await executeTurn(makeTurnInput(), [narratorManifest, charManifest], deps);

      const messages = await store.listTurnMessages('sess-test');
      const templateMsg = messages.find(m => m.pendingInput);
      expect(templateMsg).toBeDefined();

      const template = templateMsg.content;
      const filled = template
        .replace(/\{\{\s*characterName\s*\}\}/g, '林清风')
        .replace(/\{\{\s*gender\s*\}\}/g, '男')
        .replace(/\{\{\s*spiritRoot\s*\}\}/g, '水灵根');

      expect(filled).toContain('林清风');
      expect(filled).toContain('男');
      expect(filled).toContain('水灵根');
      expect(filled).not.toContain('{{');

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

      await store.savePlayerInput({
        id: 'pi-1',
        sessionId: 'sess-test',
        turnId: turn1.turnId,
        formId: 'char-creation',
        values: { characterName: '林清风', gender: '男', spiritRoot: '水灵根' },
        createdAt: new Date().toISOString(),
      });

      const turn2 = await executeTurn(
        makeTurnInput({ turnId: 'turn-2', playerMessage: '我环顾四周' }),
        [narratorManifest],
        deps,
      );

      expect(mockLLM.callCount).toBeGreaterThanOrEqual(3);

      const allMessages = await store.listTurnMessages('sess-test');
      expect(allMessages.length).toBeGreaterThanOrEqual(5);
    });
  });
});
