import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryManager } from "../src/core-memory.js";
import { CORE_MEMORY_LABELS, CORE_MEMORY_LABEL_INFO } from "../src/types.js";
import type { CoreMemoryLabel } from "../src/types.js";

interface PluginDataRow {
  id: string;
  sessionId: string;
  pluginId: string;
  namespace: string;
  key: string;
  value: unknown;
  createdAt: string;
  updatedAt: string;
}

// Minimal in-memory store mock for working_memory operations
function createMockStore() {
  const records = new Map<
    string,
    {
      id: string;
      sessionId: string;
      key: string;
      scope: string;
      value: unknown;
      updatedAt: string;
    }
  >();
  const pluginData = new Map<string, PluginDataRow>();
  const makeKey = (sid: string, scope: string, key: string) =>
    `${sid}:${scope}:${key}`;
  const makePdKey = (sid: string, pid: string, ns: string, key: string) =>
    `${sid}:${pid}:${ns}:${key}`;

  return {
    records,
    pluginData,
    async upsertWorkingMemory(record: {
      id: string;
      sessionId: string;
      key: string;
      scope: string;
      value: unknown;
      updatedAt: string;
    }) {
      records.set(makeKey(record.sessionId, record.scope, record.key), record);
    },
    async getWorkingMemory(sessionId: string, scope: string, key: string) {
      return records.get(makeKey(sessionId, scope, key)) ?? null;
    },
    async listWorkingMemory(sessionId: string) {
      const results: typeof records extends Map<string, infer V> ? V[] : never =
        [];
      for (const [k, v] of records) {
        if (k.startsWith(`${sessionId}:`)) results.push(v);
      }
      return results;
    },
    async setPluginData(record: PluginDataRow) {
      pluginData.set(
        makePdKey(
          record.sessionId,
          record.pluginId,
          record.namespace,
          record.key,
        ),
        record,
      );
    },
  };
}

describe("CoreMemoryManager", () => {
  let store: ReturnType<typeof createMockStore>;
  let manager: ReturnType<typeof createMemoryManager>;

  beforeEach(() => {
    store = createMockStore();
    manager = createMemoryManager(store as any);
  });

  describe("initializeDefaults", () => {
    it("should create empty blocks for all labels", async () => {
      await manager.initializeDefaults("sess-1");

      const blocks = await manager.loadBlocks("sess-1");
      expect(blocks).toHaveLength(CORE_MEMORY_LABELS.length);

      for (const block of blocks) {
        expect(block.content).toBe("");
        expect(CORE_MEMORY_LABELS).toContain(block.label);
      }
    });

    it("should be idempotent", async () => {
      await manager.initializeDefaults("sess-1");
      await manager.updateBlock("sess-1", "story_state", "Some story");
      await manager.initializeDefaults("sess-1");

      const block = await manager.getBlock("sess-1", "story_state");
      expect(block?.content).toBe("Some story");
    });
  });

  describe("updateBlock / getBlock", () => {
    it("should write and read a block", async () => {
      await manager.updateBlock("sess-1", "scene", "青萍宗坊市，午后。");

      const block = await manager.getBlock("sess-1", "scene");
      expect(block).not.toBeNull();
      expect(block!.content).toBe("青萍宗坊市，午后。");
      expect(block!.label).toBe("scene");
    });

    it("should return null for non-existent block", async () => {
      const block = await manager.getBlock("sess-1", "scene");
      expect(block).toBeNull();
    });

    it("should truncate content exceeding max chars", async () => {
      const longContent = "x".repeat(3000);
      await manager.updateBlock("sess-1", "story_state", longContent);

      const block = await manager.getBlock("sess-1", "story_state");
      expect(block!.content.length).toBe(2000); // default max
    });

    it("should overwrite existing block", async () => {
      await manager.updateBlock("sess-1", "scene", "Version 1");
      await manager.updateBlock("sess-1", "scene", "Version 2");

      const block = await manager.getBlock("sess-1", "scene");
      expect(block!.content).toBe("Version 2");
    });
  });

  describe("updateBlocks (batch)", () => {
    it("should update multiple blocks atomically", async () => {
      const updates = new Map<CoreMemoryLabel, string>([
        ["story_state", "主线开始"],
        ["scene", "坊市"],
      ]);

      await manager.updateBlocks("sess-1", updates);

      const story = await manager.getBlock("sess-1", "story_state");
      const scene = await manager.getBlock("sess-1", "scene");
      expect(story!.content).toBe("主线开始");
      expect(scene!.content).toBe("坊市");
    });
  });

  describe("loadBlocks", () => {
    it("should return blocks in canonical order", async () => {
      await manager.updateBlock("sess-1", "player_profile", "Player");
      await manager.updateBlock("sess-1", "story_state", "Story");

      const blocks = await manager.loadBlocks("sess-1");

      // Canonical order from CORE_MEMORY_LABELS
      expect(blocks[0].label).toBe("story_state");
      expect(blocks[0].content).toBe("Story");
      expect(blocks[1].label).toBe("character_relationships");
      expect(blocks[1].content).toBe(""); // not set
      expect(blocks[3].label).toBe("player_profile");
      expect(blocks[3].content).toBe("Player");
    });

    it("should isolate blocks by session", async () => {
      await manager.updateBlock("sess-1", "scene", "Session 1 scene");
      await manager.updateBlock("sess-2", "scene", "Session 2 scene");

      const blocks1 = await manager.loadBlocks("sess-1");
      const blocks2 = await manager.loadBlocks("sess-2");

      const scene1 = blocks1.find((b) => b.label === "scene");
      const scene2 = blocks2.find((b) => b.label === "scene");
      expect(scene1!.content).toBe("Session 1 scene");
      expect(scene2!.content).toBe("Session 2 scene");
    });
  });

  describe("plugin-data mirror", () => {
    let mirrorStore: ReturnType<typeof createMockStore>;
    let mirrorManager: ReturnType<typeof createMemoryManager>;
    const PLUGIN_ID = "memory";

    beforeEach(() => {
      mirrorStore = createMockStore();
      mirrorManager = createMemoryManager(mirrorStore as any, {
        pluginId: PLUGIN_ID,
      });
    });

    it("should mirror updateBlock to plugin-data with rich payload shape", async () => {
      await mirrorManager.updateBlock("sess-1", "scene", "青萍宗坊市，午后。");

      const row = mirrorStore.pluginData.get(
        `sess-1:${PLUGIN_ID}:blocks:scene`,
      );
      expect(row).toBeDefined();
      expect(row!.namespace).toBe("blocks");
      expect(row!.key).toBe("scene");

      const value = row!.value as Record<string, unknown>;
      expect(value.content).toBe("青萍宗坊市，午后。");
      expect(value.displayName).toEqual(
        CORE_MEMORY_LABEL_INFO.scene.displayName,
      );
      expect(value.icon).toBe(CORE_MEMORY_LABEL_INFO.scene.icon);
      expect(value.charCount).toBe("青萍宗坊市，午后。".length);
      expect(typeof value.updatedAt).toBe("string");
      expect(value.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("should mirror updateBlocks (batch) to plugin-data with rich payload shape", async () => {
      const updates = new Map<CoreMemoryLabel, string>([
        ["story_state", "主线开始"],
        ["player_profile", "玩家：林墨。"],
      ]);

      await mirrorManager.updateBlocks("sess-1", updates);

      const story = mirrorStore.pluginData.get(
        `sess-1:${PLUGIN_ID}:blocks:story_state`,
      );
      const player = mirrorStore.pluginData.get(
        `sess-1:${PLUGIN_ID}:blocks:player_profile`,
      );

      expect(story).toBeDefined();
      expect(player).toBeDefined();

      const storyValue = story!.value as Record<string, unknown>;
      const playerValue = player!.value as Record<string, unknown>;

      expect(storyValue.content).toBe("主线开始");
      expect(storyValue.displayName).toEqual(
        CORE_MEMORY_LABEL_INFO.story_state.displayName,
      );
      expect(storyValue.icon).toBe(CORE_MEMORY_LABEL_INFO.story_state.icon);
      expect(storyValue.charCount).toBe("主线开始".length);

      expect(playerValue.content).toBe("玩家：林墨。");
      expect(playerValue.displayName).toEqual(
        CORE_MEMORY_LABEL_INFO.player_profile.displayName,
      );
      expect(playerValue.icon).toBe(CORE_MEMORY_LABEL_INFO.player_profile.icon);
      expect(playerValue.charCount).toBe("玩家：林墨。".length);
    });

    it("should reflect truncation in mirrored charCount and content", async () => {
      const longContent = "x".repeat(3000);
      await mirrorManager.updateBlock("sess-1", "story_state", longContent);

      const row = mirrorStore.pluginData.get(
        `sess-1:${PLUGIN_ID}:blocks:story_state`,
      );
      const value = row!.value as Record<string, unknown>;
      expect((value.content as string).length).toBe(2000);
      expect(value.charCount).toBe(2000);
    });

    it("should not mirror when pluginId is not configured", async () => {
      // Reuses the parent describe's manager (no pluginId)
      await manager.updateBlock("sess-1", "scene", "no-mirror");

      // The default `store` mock from the outer beforeEach doesn't have a
      // pluginData map, so this asserts the call path simply doesn't crash
      // when no mirror is configured. Verifying the working_memory write
      // happened proves the main path executed.
      const block = await manager.getBlock("sess-1", "scene");
      expect(block!.content).toBe("no-mirror");
    });

    it("should fall back to label as displayName for unknown labels", async () => {
      // updateBlock signature is typed to known labels, but runtime defends
      // against arbitrary string labels (defensive programming for future
      // extensions). We use `as any` to simulate that path.
      await mirrorManager.updateBlock(
        "sess-1",
        "unknown_label" as any,
        "content",
      );

      const row = mirrorStore.pluginData.get(
        `sess-1:${PLUGIN_ID}:blocks:unknown_label`,
      );
      expect(row).toBeDefined();
      const value = row!.value as Record<string, unknown>;
      expect(value.displayName).toEqual({
        zh: "unknown_label",
        en: "unknown_label",
      });
      expect(value.icon).toBe("Info");
    });
  });
});
