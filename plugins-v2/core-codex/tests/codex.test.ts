/**
 * core-codex plugin tests.
 *
 * Tests:
 * 1. Plugin discovery & manifest validation
 * 2. Local tools: unlock-codex-entries + update-codex-entry
 * 3. Batch unlock (multiple entries in one call)
 * 4. UI card generation with rarity styles
 * 5. Integration: mock LLM calls tool → framework extracts UI
 */

import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import type { RuntimeManifest } from '../../../packages/shared/src/types/index.js';
import { discoverPlugins, loadPluginManifest, loadRuntime } from '../../../packages/plugin-loader/src/index.js';
import type { LoadedRuntime } from '../../../packages/plugin-loader/src/types.js';
import { createMemoryStore } from '../../../packages/store/src/memory/memory-store.js';
import { executeTurn } from '../../../packages/runtime/src/turn-executor.js';
import type { TurnExecutorDeps } from '../../../packages/runtime/src/turn-executor.js';
import { createToolExecutor } from '../../../packages/runtime/src/tool-executor.js';
import type { LLMAdapter, LLMResponse } from '../../../packages/runtime/src/llm-adapter.js';
import { unlockCodexEntriesTool } from '../tools/unlock-codex-entries.js';
import { updateCodexEntryTool } from '../tools/update-codex-entry.js';
import { createNotificationTool } from '../../../packages/tools/src/builtin/ui-tools.js';

// ── Helpers ───────────────────────────────────────────────────────

const PLUGINS_DIR = path.resolve(import.meta.dirname, '../..');

function makeToolExecutor() {
  return createToolExecutor({
    findTool: (name) => {
      if (name === 'unlock-codex-entries') return unlockCodexEntriesTool;
      if (name === 'update-codex-entry') return updateCodexEntryTool;
      if (name === 'create-notification') return createNotificationTool;
      return undefined;
    },
  });
}

// ── Tool unit tests ──────────────────────────────────────────────

describe('core-codex tools', () => {
  const ctx = { sessionId: 'sess-1', turnId: 'turn-1', pluginId: 'core-codex', runtimeId: 'core-codex' };

  describe('unlock-codex-entries', () => {
    it('should unlock a single entry with UI card', async () => {
      const result = await unlockCodexEntriesTool.execute({
        entries: [{
          category: 'location',
          title: '青萍山',
          content: '青萍宗所在的灵脉山峰，外门在山腰，内门在山顶。',
          tags: ['宗门', '灵脉'],
          rarity: 'common',
        }],
      }, ctx) as Record<string, unknown>;

      expect(result.unlocked).toBe(1);
      const entries = result.entries as Array<Record<string, unknown>>;
      expect(entries[0].title).toBe('青萍山');
      expect(entries[0].entryId).toBeDefined();

      const ui = result.ui as Array<Record<string, unknown>>;
      expect(ui[0].type).toBe('codex-discovery');
      expect((ui[0].style as Record<string, unknown>).icon).toBe('🗺️');
    });

    it('should batch unlock multiple entries', async () => {
      const result = await unlockCodexEntriesTool.execute({
        entries: [
          { category: 'character', title: '苏婉', content: '青萍宗外门首席弟子，冰灵根。', tags: ['弟子', '冰灵根'], rarity: 'uncommon' },
          { category: 'item', title: '梦莲', content: '野生灵植，可短暂扩展灵识但有成瘾风险。', tags: ['灵植', '危险'], rarity: 'rare' },
          { category: 'monster', title: '瘴气蟾蜍', content: '百灵沼泽常见妖兽，练气中期实力。', tags: ['妖兽', '沼泽'], rarity: 'common' },
        ],
      }, ctx) as Record<string, unknown>;

      expect(result.unlocked).toBe(3);
      const ui = result.ui as Array<Record<string, unknown>>;
      expect(ui).toHaveLength(3);

      // Check rarity-based styling
      expect((ui[0].style as Record<string, unknown>).borderColor).toBe('#3b82f6'); // uncommon = blue
      expect((ui[1].style as Record<string, unknown>).borderColor).toBe('#a855f7'); // rare = purple
      expect((ui[1].style as Record<string, unknown>).animation).toBe('shimmer');   // rare animation
      expect((ui[2].style as Record<string, unknown>).borderColor).toBe('#6b7280'); // common = gray
    });

    it('should generate legendary entry with glow animation', async () => {
      const result = await unlockCodexEntriesTool.execute({
        entries: [{
          category: 'lore',
          title: '上古灵潮',
          content: '远古天地灵气复苏事件，云梦泽由此成为灵气最浓郁的区域。',
          tags: ['上古', '灵气', '历史'],
          rarity: 'legendary',
          imageHint: '远古天空裂开，金色灵气如瀑布倾泻而下',
        }],
      }, ctx) as Record<string, unknown>;

      const ui = result.ui as Array<Record<string, unknown>>;
      expect((ui[0].style as Record<string, unknown>).animation).toBe('glow');
      expect((ui[0].style as Record<string, unknown>).borderColor).toBe('#ff8c00');
      expect(ui[0].imageHint).toBe('远古天空裂开，金色灵气如瀑布倾泻而下');
    });
  });

  describe('update-codex-entry', () => {
    it('should update existing entry', async () => {
      const result = await updateCodexEntryTool.execute({
        entryId: 'codex-123',
        appendContent: '据传青萍山灵脉近年有衰退迹象，原因不明。',
      }, ctx) as Record<string, unknown>;

      expect(result.updated).toBe(true);
      expect(result.entryId).toBe('codex-123');
      const ui = result.ui as Array<Record<string, unknown>>;
      expect(ui[0].type).toBe('codex-update');
    });

    it('should support rarity upgrade', async () => {
      const result = await updateCodexEntryTool.execute({
        entryId: 'codex-123',
        appendContent: '发现梦莲与上古封印有直接关联！',
        rarityUpgrade: 'legendary',
      }, ctx) as Record<string, unknown>;

      const ui = result.ui as Array<Record<string, unknown>>;
      expect(ui[0].rarityUpgrade).toBe('legendary');
      expect((ui[0].style as Record<string, unknown>).animation).toBe('upgrade-pulse');
    });
  });
});

// ── Plugin discovery tests ───────────────────────────────────────

describe('core-codex plugin manifest', () => {
  let manifest: RuntimeManifest;
  let loaded: LoadedRuntime;

  beforeAll(async () => {
    const discoveries = await discoverPlugins(PLUGINS_DIR);
    const discovery = discoveries.find(d => d.id === 'core-codex')!;
    const manifests = await loadPluginManifest(discovery);
    manifest = manifests[0].manifest;
    loaded = await loadRuntime(discovery, manifest.name);
  });

  it('should be a non-core plugin', () => {
    expect(manifest.pluginType).toBe('plugin');
    expect(manifest.name).toBe('core-codex');
    expect(manifest.priority).toBe(650);
  });

  it('should declare local tools', () => {
    expect(manifest.tools?.local).toContain('./tools/unlock-codex-entries.ts');
    expect(manifest.tools?.local).toContain('./tools/update-codex-entry.ts');
  });

  it('should declare builtin notification tool', () => {
    expect(manifest.tools?.builtin).toContain('create-notification');
  });

  it('should have auto trigger', () => {
    expect(manifest.trigger?.type).toBe('auto');
  });

  it('should load prompt template', () => {
    expect(loaded.promptTemplate).toContain('知识图鉴');
    expect(loaded.promptTemplate).toContain('unlock-codex-entries');
  });
});

// ── Integration test with mock LLM ──────────────────────────────

describe('core-codex integration', () => {
  it('should execute tool calls and produce UI cards', async () => {
    const store = createMemoryStore();

    // Mock LLM that calls unlock-codex-entries with 2 entries
    const mockLLM: LLMAdapter = {
      callCount: 0,
      async generate(params) {
        (this as { callCount: number }).callCount++;
        const sys = params.messages.find(m => m.role === 'system');
        if (sys?.content.includes('知识图鉴')) {
          const hasToolResult = params.messages.some(m => m.role === 'tool');
          if (hasToolResult) {
            return { content: '', toolCalls: [], finishReason: 'stop', usage: { inputTokens: 50, outputTokens: 10 } };
          }
          return {
            content: '',
            toolCalls: [{
              id: 'call-codex-1',
              name: 'unlock-codex-entries',
              arguments: JSON.stringify({
                entries: [
                  { category: 'location', title: '坊市', content: '青萍山外门弟子交易灵石、丹药的集市。', tags: ['交易', '青萍宗'], rarity: 'common' },
                  { category: 'character', title: '苏婉', content: '外门首席弟子，冰灵根，发现了野生灵脉。', tags: ['弟子', '冰灵根'], rarity: 'uncommon' },
                ],
              }),
            }],
            finishReason: 'tool_calls',
            usage: { inputTokens: 100, outputTokens: 50 },
          };
        }
        return { content: '你走进坊市...', toolCalls: [], finishReason: 'stop', usage: { inputTokens: 50, outputTokens: 30 } };
      },
    } as LLMAdapter & { callCount: number };

    // Load codex manifest
    const discoveries = await discoverPlugins(PLUGINS_DIR);
    const codexDiscovery = discoveries.find(d => d.id === 'core-codex')!;
    const codexManifests = await loadPluginManifest(codexDiscovery);
    const codexManifest = codexManifests[0].manifest;
    const codexLoaded = await loadRuntime(codexDiscovery, codexManifest.name);

    const deps: TurnExecutorDeps = {
      loadRuntime: async () => codexLoaded,
      llm: mockLLM,
      getConfig: () => ({}),
      store,
      toolExecutor: createToolExecutor({
        findTool: (name) => {
          if (name === 'unlock-codex-entries') return unlockCodexEntriesTool;
          if (name === 'update-codex-entry') return updateCodexEntryTool;
          if (name === 'create-notification') return createNotificationTool;
          return undefined;
        },
        store, // Pass store for recording tool calls
      }),
    };

    const result = await executeTurn(
      { sessionId: 'sess-codex', turnId: 'turn-1', playerMessage: '我走进坊市' },
      [codexManifest],
      deps,
    );

    expect(result.runtimeResults).toHaveLength(1);
    const codexResult = result.runtimeResults[0];
    expect(codexResult.status).toBe('success');

    // Verify tool calls were recorded in store
    const toolCalls = await store.listToolCalls('sess-codex');
    expect(toolCalls.length).toBeGreaterThanOrEqual(1);
    expect(toolCalls[0].toolName).toBe('unlock-codex-entries');
  });
});
