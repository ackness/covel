import { describe, it, expect, beforeEach } from 'vitest';
import { createMemoryManager } from '../src/core-memory.js';
import { CORE_MEMORY_LABELS } from '../src/types.js';
import type { CoreMemoryLabel } from '../src/types.js';

// Minimal in-memory store mock for working_memory operations
function createMockStore() {
  const records = new Map<string, { id: string; sessionId: string; key: string; scope: string; value: unknown; updatedAt: string }>();
  const makeKey = (sid: string, scope: string, key: string) => `${sid}:${scope}:${key}`;

  return {
    records,
    async upsertWorkingMemory(record: { id: string; sessionId: string; key: string; scope: string; value: unknown; updatedAt: string }) {
      records.set(makeKey(record.sessionId, record.scope, record.key), record);
    },
    async getWorkingMemory(sessionId: string, scope: string, key: string) {
      return records.get(makeKey(sessionId, scope, key)) ?? null;
    },
    async listWorkingMemory(sessionId: string) {
      const results: typeof records extends Map<string, infer V> ? V[] : never = [];
      for (const [k, v] of records) {
        if (k.startsWith(`${sessionId}:`)) results.push(v);
      }
      return results;
    },
  };
}

describe('CoreMemoryManager', () => {
  let store: ReturnType<typeof createMockStore>;
  let manager: ReturnType<typeof createMemoryManager>;

  beforeEach(() => {
    store = createMockStore();
    manager = createMemoryManager(store as any);
  });

  describe('initializeDefaults', () => {
    it('should create empty blocks for all labels', async () => {
      await manager.initializeDefaults('sess-1');

      const blocks = await manager.loadBlocks('sess-1');
      expect(blocks).toHaveLength(CORE_MEMORY_LABELS.length);

      for (const block of blocks) {
        expect(block.content).toBe('');
        expect(CORE_MEMORY_LABELS).toContain(block.label);
      }
    });

    it('should be idempotent', async () => {
      await manager.initializeDefaults('sess-1');
      await manager.updateBlock('sess-1', 'story_state', 'Some story');
      await manager.initializeDefaults('sess-1');

      const block = await manager.getBlock('sess-1', 'story_state');
      expect(block?.content).toBe('Some story');
    });
  });

  describe('updateBlock / getBlock', () => {
    it('should write and read a block', async () => {
      await manager.updateBlock('sess-1', 'scene', '青萍宗坊市，午后。');

      const block = await manager.getBlock('sess-1', 'scene');
      expect(block).not.toBeNull();
      expect(block!.content).toBe('青萍宗坊市，午后。');
      expect(block!.label).toBe('scene');
    });

    it('should return null for non-existent block', async () => {
      const block = await manager.getBlock('sess-1', 'scene');
      expect(block).toBeNull();
    });

    it('should truncate content exceeding max chars', async () => {
      const longContent = 'x'.repeat(3000);
      await manager.updateBlock('sess-1', 'story_state', longContent);

      const block = await manager.getBlock('sess-1', 'story_state');
      expect(block!.content.length).toBe(2000); // default max
    });

    it('should overwrite existing block', async () => {
      await manager.updateBlock('sess-1', 'scene', 'Version 1');
      await manager.updateBlock('sess-1', 'scene', 'Version 2');

      const block = await manager.getBlock('sess-1', 'scene');
      expect(block!.content).toBe('Version 2');
    });
  });

  describe('updateBlocks (batch)', () => {
    it('should update multiple blocks atomically', async () => {
      const updates = new Map<CoreMemoryLabel, string>([
        ['story_state', '主线开始'],
        ['scene', '坊市'],
      ]);

      await manager.updateBlocks('sess-1', updates);

      const story = await manager.getBlock('sess-1', 'story_state');
      const scene = await manager.getBlock('sess-1', 'scene');
      expect(story!.content).toBe('主线开始');
      expect(scene!.content).toBe('坊市');
    });
  });

  describe('loadBlocks', () => {
    it('should return blocks in canonical order', async () => {
      await manager.updateBlock('sess-1', 'player_profile', 'Player');
      await manager.updateBlock('sess-1', 'story_state', 'Story');

      const blocks = await manager.loadBlocks('sess-1');

      // Canonical order from CORE_MEMORY_LABELS
      expect(blocks[0].label).toBe('story_state');
      expect(blocks[0].content).toBe('Story');
      expect(blocks[1].label).toBe('character_relationships');
      expect(blocks[1].content).toBe(''); // not set
      expect(blocks[3].label).toBe('player_profile');
      expect(blocks[3].content).toBe('Player');
    });

    it('should isolate blocks by session', async () => {
      await manager.updateBlock('sess-1', 'scene', 'Session 1 scene');
      await manager.updateBlock('sess-2', 'scene', 'Session 2 scene');

      const blocks1 = await manager.loadBlocks('sess-1');
      const blocks2 = await manager.loadBlocks('sess-2');

      const scene1 = blocks1.find((b) => b.label === 'scene');
      const scene2 = blocks2.find((b) => b.label === 'scene');
      expect(scene1!.content).toBe('Session 1 scene');
      expect(scene2!.content).toBe('Session 2 scene');
    });
  });
});
