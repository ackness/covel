import { describe, it, expect } from "vitest";
import { createMemorySystem } from "../src/memory-system.js";
import { createMemoryManager } from "../src/core-memory.js";
import { createMemoryUpdater } from "../src/updater.js";
import type { CoreMemoryBlockSchema, MemoryLLMAdapter } from "../src/types.js";

/**
 * Proves the architecture win: a new game type (detective) can declare its own
 * core-memory blocks via a block schema and drive extraction + rendering
 * end-to-end — with NO default ("story_state" etc.) labels leaking in.
 */
const DETECTIVE_BLOCKS: readonly CoreMemoryBlockSchema[] = [
  {
    label: "clues",
    displayName: { zh: "线索", en: "Clues" },
    icon: "Search",
    extractionHint: {
      zh: "已发现的线索与物证。",
      en: "Discovered clues and physical evidence.",
    },
  },
  {
    label: "suspects",
    displayName: { zh: "嫌疑人", en: "Suspects" },
    icon: "UserSearch",
    extractionHint: {
      zh: "嫌疑人及其动机、不在场证明。",
      en: "Suspects, their motives, and alibis.",
    },
  },
];

function createMockStore() {
  const records = new Map<string, any>();
  const makeKey = (sid: string, scope: string, key: string) =>
    `${sid}:${scope}:${key}`;
  return {
    async upsertWorkingMemory(record: any) {
      records.set(makeKey(record.sessionId, record.scope, record.key), record);
    },
    async getWorkingMemory(sessionId: string, scope: string, key: string) {
      return records.get(makeKey(sessionId, scope, key)) ?? null;
    },
    async listWorkingMemory(sessionId: string) {
      const out: any[] = [];
      for (const [k, v] of records)
        if (k.startsWith(`${sessionId}:`)) out.push(v);
      return out;
    },
  };
}

function mockLLM(response: string): MemoryLLMAdapter {
  return {
    async complete() {
      return { content: response };
    },
  };
}

describe("custom (non-default) core-memory block schema", () => {
  it("manager governs exactly the declared custom labels", async () => {
    const store = createMockStore();
    const manager = createMemoryManager(store as any, {
      blocks: DETECTIVE_BLOCKS,
    });
    await manager.initializeDefaults("s1");
    const blocks = await manager.loadBlocks("s1");
    expect(blocks.map((b) => b.label)).toEqual(["clues", "suspects"]);
    // Display name comes from the injected schema, not a hardcoded map.
    expect(blocks[0].displayName).toEqual({ zh: "线索", en: "Clues" });
  });

  it("updater accepts custom labels and rejects default ones", async () => {
    const store = createMockStore();
    const manager = createMemoryManager(store as any, {
      blocks: DETECTIVE_BLOCKS,
    });
    const updater = createMemoryUpdater(
      manager,
      mockLLM(JSON.stringify({ clues: "血迹手帕", story_state: "应被忽略" })),
      { blocks: DETECTIVE_BLOCKS },
    );

    const result = await updater.updateAfterTurn({
      sessionId: "s1",
      narrativeText: "侦探在书房发现一块带血的手帕。",
      currentBlocks: await manager.loadBlocks("s1"),
    });

    expect(result.blocksChanged).toEqual(["clues"]); // story_state filtered out
    const clues = await manager.getBlock("s1", "clues");
    expect(clues!.content).toBe("血迹手帕");
  });

  it("createMemorySystem threads the schema to manager + updater", async () => {
    const store = createMockStore();
    const system = createMemorySystem(
      {
        store: store as any,
        llm: mockLLM(JSON.stringify({ suspects: "园丁" })),
      },
      { coreMemory: { blocks: DETECTIVE_BLOCKS } },
    );
    await system.manager.initializeDefaults("s2");
    const result = await system.updater.updateAfterTurn({
      sessionId: "s2",
      narrativeText: "园丁的证词出现矛盾。",
      currentBlocks: await system.manager.loadBlocks("s2"),
    });
    expect(result.blocksChanged).toEqual(["suspects"]);
  });
});
