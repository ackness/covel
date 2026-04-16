import { describe, it, expect, beforeEach } from 'vitest';
import { createMemoryUpdater } from '../src/updater.js';
import { createMemoryManager } from '../src/core-memory.js';
import type { CoreMemoryBlock, MemoryLLMAdapter } from '../src/types.js';

function createMockStore() {
  const records = new Map<string, any>();
  const makeKey = (sid: string, scope: string, key: string) => `${sid}:${scope}:${key}`;
  return {
    async upsertWorkingMemory(record: any) {
      records.set(makeKey(record.sessionId, record.scope, record.key), record);
    },
    async getWorkingMemory(sessionId: string, scope: string, key: string) {
      return records.get(makeKey(sessionId, scope, key)) ?? null;
    },
    async listWorkingMemory(sessionId: string) {
      const results: any[] = [];
      for (const [k, v] of records) {
        if (k.startsWith(`${sessionId}:`)) results.push(v);
      }
      return results;
    },
  };
}

function createMockLLM(response: string): MemoryLLMAdapter {
  return {
    async complete() {
      return { content: response };
    },
  };
}

describe('MemoryUpdater', () => {
  let store: ReturnType<typeof createMockStore>;
  let manager: ReturnType<typeof createMemoryManager>;
  const currentBlocks: CoreMemoryBlock[] = [
    { label: 'story_state', content: '玩家刚到坊市', updatedAt: '2026-01-01T00:00:00Z' },
    { label: 'scene', content: '坊市', updatedAt: '2026-01-01T00:00:00Z' },
    { label: 'character_relationships', content: '', updatedAt: '2026-01-01T00:00:00Z' },
    { label: 'player_profile', content: '练气三层', updatedAt: '2026-01-01T00:00:00Z' },
  ];

  beforeEach(() => {
    store = createMockStore();
    manager = createMemoryManager(store as any);
  });

  it('should parse JSON response and update blocks', async () => {
    const llm = createMockLLM(JSON.stringify({
      scene: '百灵沼泽入口，黄昏时分',
      story_state: '玩家和苏婉出发前往百灵沼泽',
    }));

    const updater = createMemoryUpdater(manager, llm);
    const result = await updater.updateAfterTurn({
      sessionId: 'sess-1',
      narrativeText: '你和苏婉离开坊市...',
      currentBlocks,
    });

    expect(result.updated).toBe(true);
    expect(result.blocksChanged).toContain('scene');
    expect(result.blocksChanged).toContain('story_state');
    expect(result.blocksChanged).toHaveLength(2);

    const scene = await manager.getBlock('sess-1', 'scene');
    expect(scene!.content).toBe('百灵沼泽入口，黄昏时分');
  });

  it('should handle markdown-wrapped JSON', async () => {
    const llm = createMockLLM('```json\n{"scene": "新场景"}\n```');
    const updater = createMemoryUpdater(manager, llm);
    const result = await updater.updateAfterTurn({
      sessionId: 'sess-1',
      narrativeText: '...',
      currentBlocks,
    });

    expect(result.updated).toBe(true);
    expect(result.blocksChanged).toEqual(['scene']);
  });

  it('should handle empty response (no updates needed)', async () => {
    const llm = createMockLLM('{}');
    const updater = createMemoryUpdater(manager, llm);
    const result = await updater.updateAfterTurn({
      sessionId: 'sess-1',
      narrativeText: '一切平静...',
      currentBlocks,
    });

    expect(result.updated).toBe(false);
    expect(result.blocksChanged).toHaveLength(0);
  });

  it('should handle malformed LLM output gracefully', async () => {
    const llm = createMockLLM('I am confused, here is no JSON');
    const updater = createMemoryUpdater(manager, llm);
    const result = await updater.updateAfterTurn({
      sessionId: 'sess-1',
      narrativeText: '...',
      currentBlocks,
    });

    expect(result.updated).toBe(false);
    expect(result.blocksChanged).toHaveLength(0);
  });

  it('should handle LLM call failure gracefully', async () => {
    const llm: MemoryLLMAdapter = {
      async complete() { throw new Error('LLM timeout'); },
    };
    const updater = createMemoryUpdater(manager, llm);
    const result = await updater.updateAfterTurn({
      sessionId: 'sess-1',
      narrativeText: '...',
      currentBlocks,
    });

    expect(result.updated).toBe(false);
    expect(result.error).toBe('LLM timeout');
  });

  it('should ignore invalid block labels in response', async () => {
    const llm = createMockLLM(JSON.stringify({
      scene: '有效更新',
      invalid_label: '这个应该被忽略',
    }));
    const updater = createMemoryUpdater(manager, llm);
    const result = await updater.updateAfterTurn({
      sessionId: 'sess-1',
      narrativeText: '...',
      currentBlocks,
    });

    expect(result.blocksChanged).toEqual(['scene']);
  });
});
