/**
 * core-codex plugin tests.
 *
 * Tests:
 * 1. Plugin discovery & manifest validation
 * 2. Local tools: unlock-codex-entries + update-codex-entry
 * 3. Batch unlock (multiple entries in one call)
 * 4. UI card generation with rarity styles
 * 5. Persistence to plugin-data store
 * 6. Integration: mock LLM calls tool → framework extracts UI
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import path from 'node:path';
import { discoverPlugins, loadPluginManifest, loadRuntime } from '@covel/plugin-loader';
import { tool, z, shortIdBatch } from '@covel/tools';
import createUnlockCodexEntries from '../tools/unlock-codex-entries.js';
import createUpdateCodexEntry from '../tools/update-codex-entry.js';
import codexHandler from '../handler.js';

// In-memory mock store for plugin-data operations
function createMockPluginDataStore() {
  /** @type {Map<string, unknown>} */
  const data = new Map();
  const makeKey = (sid, pid, ns, k) => `${sid}:${pid}:${ns}:${k}`;

  return {
    data,
    async setPluginData(record) {
      data.set(makeKey(record.sessionId, record.pluginId, record.namespace, record.key), {
        namespace: record.namespace,
        key: record.key,
        value: record.value,
        updatedAt: record.updatedAt,
      });
    },
    async setPluginDataBatch(records) {
      for (const r of records) await this.setPluginData(r);
    },
    async getPluginData(sessionId, pluginId, namespace, key) {
      return data.get(makeKey(sessionId, pluginId, namespace, key)) ?? null;
    },
    async listPluginData(sessionId, pluginId, namespace) {
      const results = [];
      for (const [k, v] of data) {
        if (k.startsWith(`${sessionId}:${pluginId}:`) && (!namespace || k.startsWith(`${sessionId}:${pluginId}:${namespace}:`))) {
          results.push(v);
        }
      }
      return results;
    },
  };
}

const PLUGINS_DIR = path.resolve(import.meta.dirname, '../..');

// ── Tool unit tests ──────────────────────────────────────────────

describe('core-codex tools', () => {
  const ctx = { sessionId: 'sess-1', turnId: 'turn-1', pluginId: 'core-codex', runtimeId: 'core-codex' };
  let mockStore;
  let unlockCodexEntriesTool;
  let updateCodexEntryTool;

  beforeEach(() => {
    mockStore = createMockPluginDataStore();
    unlockCodexEntriesTool = createUnlockCodexEntries({ tool, z, shortIdBatch, store: mockStore });
    updateCodexEntryTool = createUpdateCodexEntry({ tool, z, store: mockStore });
  });

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

    it('should persist entries to plugin-data store', async () => {
      const result = await unlockCodexEntriesTool.execute({
        entries: [{
          category: 'location',
          title: '青萍山',
          content: '青萍宗所在的灵脉山峰。',
          tags: ['宗门'],
          rarity: 'common',
        }],
      }, ctx);

      const entryId = result.entries[0].entryId;
      const stored = await mockStore.getPluginData('sess-1', 'core-codex', 'entries', entryId);
      expect(stored).not.toBeNull();
      expect(stored.value.title).toBe('青萍山');
      expect(stored.value.category).toBe('location');
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

      // All 3 entries persisted
      const stored = await mockStore.listPluginData('sess-1', 'core-codex', 'entries');
      expect(stored).toHaveLength(3);
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
    it('should update existing entry from store', async () => {
      // First unlock an entry so it exists in store
      const unlockResult = await unlockCodexEntriesTool.execute({
        entries: [{
          category: 'location',
          title: '青萍山',
          content: '青萍宗所在的灵脉山峰。',
          tags: ['宗门'],
          rarity: 'common',
        }],
      }, ctx);

      const entryId = unlockResult.entries[0].entryId;

      const result = await updateCodexEntryTool.execute({
        entryId,
        appendContent: '据传青萍山灵脉近年有衰退迹象，原因不明。',
      }, ctx);

      expect(result.updated).toBe(true);
      expect(result.entryId).toBe(entryId);
      expect(result.ui[0].type).toBe('codex-update');

      // Verify store was updated
      const stored = await mockStore.getPluginData('sess-1', 'core-codex', 'entries', entryId);
      expect(stored.value.content).toContain('衰退迹象');
    });

    it('should return error for non-existent entry', async () => {
      const result = await updateCodexEntryTool.execute({
        entryId: 'codex-nonexistent',
        appendContent: 'some content',
      }, ctx);

      expect(result.updated).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should support rarity upgrade', async () => {
      // First unlock
      const unlockResult = await unlockCodexEntriesTool.execute({
        entries: [{
          category: 'item',
          title: '梦莲',
          content: '野生灵植，可短暂扩展灵识但有成瘾风险。',
          tags: ['灵植'],
          rarity: 'common',
        }],
      }, ctx);
      const entryId = unlockResult.entries[0].entryId;

      const result = await updateCodexEntryTool.execute({
        entryId,
        appendContent: '发现梦莲与上古封印有直接关联！',
        rarityUpgrade: 'legendary',
      }, ctx);

      expect(result.ui[0].rarityUpgrade).toBe('legendary');
      expect(result.ui[0].style.animation).toBe('upgrade-pulse');

      // Verify rarity updated in store
      const stored = await mockStore.getPluginData('sess-1', 'core-codex', 'entries', entryId);
      expect(stored.value.rarity).toBe('legendary');
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
    expect(manifest.runtimeType).toBe('function');
  });

  it('should not declare LLM-only fields (function runtime)', () => {
    // PR-5.4 cleanup: core-codex is a function runtime, so tools/inject/postHistory
    // declarations are vestigial and have been removed from PLUGIN.md. The handler
    // does direct store writes via its `store` parameter.
    expect(manifest.tools).toBeUndefined();
    expect(manifest.input).toBeUndefined();
    expect(manifest.postHistory).toBeUndefined();
    expect(manifest.promptVersion).toBeUndefined();
  });

  it('should have scheduled trigger with interval', () => {
    expect(manifest.trigger?.type).toBe('scheduled');
    expect(manifest.trigger?.interval).toBe(2);
  });

  it('should load PLUGIN.md body as a function-runtime description', () => {
    // The body is documentation only — function runtimes never feed it to an LLM.
    expect(loaded.promptTemplate).toContain('function runtime');
    expect(loaded.promptTemplate).toContain('handler.js');
  });

  it('should declare right panel UI spec', () => {
    expect(manifest.ui).toBeDefined();
    expect(manifest.ui?.right).toContain('./ui/codex-panel.json');
  });

  it('should load UI spec JSON with panel metadata', () => {
    expect(loaded.uiSpecs).toBeDefined();
    expect(loaded.uiSpecs?.right).toHaveLength(1);
    expect(loaded.uiSpecs?.right?.[0].id).toBe('codex');
    expect(loaded.uiSpecs?.right?.[0].icon).toBe('book-open');
  });
});

// ── Integration test with TestHarness ────────────────────────────

describe('core-codex integration', () => {
  it('should extract codex discoveries and persist them via handler', async () => {
    const mockStore = createMockPluginDataStore();
    const result = await codexHandler({
      sessionId: 'sess-harness',
      turnId: 'turn-2',
      pluginId: 'core-codex',
      playerMessage: '我环顾四周，观察周围环境',
      locale: 'zh-CN',
      store: mockStore,
      completedResults: new Map([[
        'core-narrator',
        {
          output: {
            narrativeOutput:
              '苏婉压低声音：“林风，我们得立刻动身——百灵沼泽离这里有两百里。” 你注意到她左手袖口有一处焦痕，腰间佩剑微微作响。溪对岸宿舍区二楼的窗户后，有个人影正朝你们这边看。',
          },
        },
      ]]),
      config: {},
    });

    expect(result.summaryCount).toBeGreaterThanOrEqual(1);

    const stored = await mockStore.listPluginData('sess-harness', 'core-codex', 'entries');
    expect(stored.length).toBeGreaterThanOrEqual(1);
    expect(stored.some((entry) => entry.value.title === '百灵沼泽')).toBe(true);
    const summary = await mockStore.listPluginData('sess-harness', 'core-codex', 'message');
    expect(summary.some((entry) => entry.key === 'title')).toBe(true);
    expect(summary.some((entry) => entry.key === 'item1Title')).toBe(true);
  });

  it('should reject noisy pseudo-entities and keep stable location names', async () => {
    const mockStore = createMockPluginDataStore();
    await codexHandler({
      sessionId: 'sess-noise',
      turnId: 'turn-noise',
      pluginId: 'core-codex',
      playerMessage: '',
      locale: 'zh-CN',
      store: mockStore,
      completedResults: new Map([[
        'core-narrator',
        {
          output: {
            narrativeOutput:
              '春日午后的青萍宗坊市弥漫着花粉甜香，钟楼余音还在山谷间回荡。苏婉低声说百灵沼泽深处有一条新灵脉。熟悉的脚步声从坊市东侧传来，你沿着青萍山石阶看向远处。'
              + ' 远处钟声惊起一群栖息在坊市屋檐下的灵雀。',
          },
        },
      ]]),
      config: {},
    });

    const stored = await mockStore.listPluginData('sess-noise', 'core-codex', 'entries');
    const titles = stored.map((entry) => entry.value.title);

    expect(titles).toContain('青萍宗坊市');
    expect(titles).toContain('百灵沼泽');
    expect(titles).not.toContain('的青萍宗坊市');
    expect(titles).not.toContain('余音还在山谷');
    expect(titles).not.toContain('三天后就是试炼大会');
    expect(titles).not.toContain('熟悉的脚步声从坊市');
    expect(titles).not.toContain('沿着青萍山');
    expect(titles).not.toContain('惊起一群栖息在坊市');
  });
});
