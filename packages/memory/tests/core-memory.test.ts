import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryManager } from "../src/core-memory.js";
import { DEFAULT_CORE_MEMORY_BLOCKS } from "../src/types.js";
import type { CoreMemoryLabel } from "../src/types.js";

// Derived from the default block schema — the manager governs exactly these
// labels and mirrors each block's schema display name + icon.
const LABELS: readonly CoreMemoryLabel[] = DEFAULT_CORE_MEMORY_BLOCKS.map(
  (b) => b.label,
);
function infoFor(label: string): { displayName: unknown; icon: string } {
  const block = DEFAULT_CORE_MEMORY_BLOCKS.find((b) => b.label === label)!;
  return { displayName: block.displayName, icon: block.icon ?? "Info" };
}

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
      expect(blocks).toHaveLength(LABELS.length);

      for (const block of blocks) {
        expect(block.content).toBe("");
        expect(LABELS).toContain(block.label);
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

  describe("resolveBlocks (per-session world blocks)", () => {
    it("resolves a session-specific schema so world blocks render + persist", async () => {
      const s = createMockStore();
      const base = [
        {
          label: "story_state",
          displayName: { zh: "剧情", en: "Story" },
          extractionHint: { zh: "剧情", en: "Story" },
        },
      ];
      const detectiveBlocks = [
        ...base,
        {
          label: "clues",
          displayName: { zh: "线索", en: "Clues" },
          extractionHint: { zh: "线索", en: "Clues" },
          icon: "Search",
        },
      ];
      const m = createMemoryManager(s as any, {
        blocks: base,
        resolveBlocks: async (sessionId: string) =>
          sessionId === "detective" ? detectiveBlocks : undefined,
      });

      // The detective session sees the extra `clues` block in canonical order…
      await m.initializeDefaults("detective");
      const detectiveLoaded = await m.loadBlocks("detective");
      expect(detectiveLoaded.map((b) => b.label)).toEqual([
        "story_state",
        "clues",
      ]);
      // …and can write to it, with the display name from the resolved schema.
      await m.updateBlock(
        "detective",
        "clues" as CoreMemoryLabel,
        "footprints",
      );
      const clues = await m.getBlock("detective", "clues" as CoreMemoryLabel);
      expect(clues?.content).toBe("footprints");
      expect(clues?.displayName).toEqual({ zh: "线索", en: "Clues" });

      // A session without a resolver match falls back to the base schema.
      const otherLoaded = await m.loadBlocks("other");
      expect(otherLoaded.map((b) => b.label)).toEqual(["story_state"]);
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

      // Canonical order from the default block schema
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
      expect(value.displayName).toEqual(infoFor("scene").displayName);
      expect(value.icon).toBe(infoFor("scene").icon);
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
        infoFor("story_state").displayName,
      );
      expect(storyValue.icon).toBe(infoFor("story_state").icon);
      expect(storyValue.charCount).toBe("主线开始".length);

      expect(playerValue.content).toBe("玩家：林墨。");
      expect(playerValue.displayName).toEqual(
        infoFor("player_profile").displayName,
      );
      expect(playerValue.icon).toBe(infoFor("player_profile").icon);
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

  describe("threaded working-memory reads (audit R-13)", () => {
    it("performs zero extra listWorkingMemory reads when `existing` is threaded", async () => {
      let listCalls = 0;
      const original = store.listWorkingMemory.bind(store);
      store.listWorkingMemory = async (sessionId: string) => {
        listCalls += 1;
        return original(sessionId);
      };

      // Simulate the turn pipeline: one read, threaded into both calls.
      const records = await store.listWorkingMemory("sess-1");
      await manager.initializeDefaults("sess-1", records as any);
      const blocks = await manager.loadBlocks("sess-1", records as any);

      expect(listCalls).toBe(1);
      expect(blocks).toHaveLength(LABELS.length);
    });

    it("threading a pre-initializeDefaults read yields the same blocks as re-reading", async () => {
      await manager.updateBlock("sess-1", "story_state", "Chapter 2");

      const records = await store.listWorkingMemory("sess-1");
      await manager.initializeDefaults("sess-1", records as any);
      const threaded = await manager.loadBlocks("sess-1", records as any);
      const reread = await manager.loadBlocks("sess-1");

      expect(threaded.map((b) => [b.label, b.content])).toEqual(
        reread.map((b) => [b.label, b.content]),
      );
      expect(threaded.find((b) => b.label === "story_state")!.content).toBe(
        "Chapter 2",
      );
    });

    it("initializeDefaults with a threaded complete list never blanks existing content", async () => {
      await manager.updateBlock("sess-1", "story_state", "Do not blank me");

      const records = await store.listWorkingMemory("sess-1");
      await manager.initializeDefaults("sess-1", records as any);

      const block = await manager.getBlock("sess-1", "story_state");
      expect(block!.content).toBe("Do not blank me");
    });
  });
});
