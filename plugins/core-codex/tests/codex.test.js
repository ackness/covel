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
import { MockLLM, createTestHarness } from '@covel/plugin-test-utils';
import { discoverPlugins, loadPluginManifest, loadRuntime } from '@covel/plugin-loader';
import { tool, z, shortIdBatch } from '@covel/tools';
import createUnlockCodexEntries from '../tools/unlock-codex-entries.js';
import createUpdateCodexEntry from '../tools/update-codex-entry.js';

// Instantiate tools from factory functions
const unlockCodexEntriesTool = createUnlockCodexEntries({ tool, z, shortIdBatch });
const updateCodexEntryTool = createUpdateCodexEntry({ tool, z });

const PLUGINS_DIR = path.resolve(import.meta.dirname, '../..');

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
      }, ctx);

      expect(result.unlocked).toBe(1);
      expect(result.entries[0].title).toBe('青萍山');
      expect(result.entries[0].entryId).toBeDefined();
      expect(result.ui[0].type).toBe('codex-discovery');
      expect(result.ui[0].style.icon).toBe('🗺️');
    });

    it('should batch unlock multiple entries', async () => {
      const result = await unlockCodexEntriesTool.execute({
        entries: [
          { category: 'character', title: '苏婉', content: '青萍宗外门首席弟子，冰灵根。', tags: ['弟子', '冰灵根'], rarity: 'uncommon' },
          { category: 'item', title: '梦莲', content: '野生灵植，可短暂扩展灵识但有成瘾风险。', tags: ['灵植', '危险'], rarity: 'rare' },
          { category: 'monster', title: '瘴气蟾蜍', content: '百灵沼泽常见妖兽，练气中期实力。', tags: ['妖兽', '沼泽'], rarity: 'common' },
        ],
      }, ctx);

      expect(result.unlocked).toBe(3);
      expect(result.ui).toHaveLength(3);
      expect(result.ui[0].style.borderColor).toBe('#3b82f6');
      expect(result.ui[1].style.borderColor).toBe('#a855f7');
      expect(result.ui[1].style.animation).toBe('shimmer');
      expect(result.ui[2].style.borderColor).toBe('#6b7280');
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
      }, ctx);

      expect(result.ui[0].style.animation).toBe('glow');
      expect(result.ui[0].style.borderColor).toBe('#ff8c00');
      expect(result.ui[0].imageHint).toBe('远古天空裂开，金色灵气如瀑布倾泻而下');
    });
  });

  describe('update-codex-entry', () => {
    it('should update existing entry', async () => {
      const result = await updateCodexEntryTool.execute({
        entryId: 'codex-123',
        appendContent: '据传青萍山灵脉近年有衰退迹象，原因不明。',
      }, ctx);

      expect(result.updated).toBe(true);
      expect(result.entryId).toBe('codex-123');
      expect(result.ui[0].type).toBe('codex-update');
    });

    it('should support rarity upgrade', async () => {
      const result = await updateCodexEntryTool.execute({
        entryId: 'codex-123',
        appendContent: '发现梦莲与上古封印有直接关联！',
        rarityUpgrade: 'legendary',
      }, ctx);

      expect(result.ui[0].rarityUpgrade).toBe('legendary');
      expect(result.ui[0].style.animation).toBe('upgrade-pulse');
    });
  });
});

// ── Plugin discovery tests ───────────────────────────────────────

describe('core-codex plugin manifest', () => {
  /** @type {import('@covel/shared').RuntimeManifest} */
  let manifest;
  let loaded;

  beforeAll(async () => {
    const discoveries = await discoverPlugins(PLUGINS_DIR);
    const discovery = discoveries.find(d => d.id === 'core-codex');
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
    expect(manifest.tools?.local).toContain('./tools/unlock-codex-entries.js');
    expect(manifest.tools?.local).toContain('./tools/update-codex-entry.js');
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

// ── Integration test with TestHarness ────────────────────────────

describe('core-codex integration', () => {
  it('should execute tool calls and produce UI cards via harness', async () => {
    const llm = new MockLLM({
      defaultResponse: {
        content: '',
        toolCalls: [],
        finishReason: 'stop',
        usage: { inputTokens: 50, outputTokens: 10 },
      },
    });

    llm.generate = async (params) => {
      llm.calls.push({ messages: params.messages });
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
              ],
            }),
          }],
          finishReason: 'tool_calls',
          usage: { inputTokens: 100, outputTokens: 50 },
        };
      }
      return { content: '你走进坊市...', toolCalls: [], finishReason: 'stop', usage: { inputTokens: 50, outputTokens: 30 } };
    };

    const harness = await createTestHarness({
      pluginsDir: PLUGINS_DIR,
      llm,
      tools: [unlockCodexEntriesTool, updateCodexEntryTool],
      activePlugins: ['core-codex'],
    });

    const result = await harness.executeTurn('我走进坊市');

    expect(result.runtimeResults).toHaveLength(1);
    expect(result.runtimeResults[0].status).toBe('success');

    const toolCalls = await harness.store.listToolCalls('sess-harness');
    expect(toolCalls.length).toBeGreaterThanOrEqual(1);
    expect(toolCalls[0].toolName).toBe('unlock-codex-entries');
  });
});
