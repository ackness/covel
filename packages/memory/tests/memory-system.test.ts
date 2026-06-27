import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMemorySystem } from "../src/memory-system.js";
import type { CoreMemoryBlock, MemoryLLMAdapter } from "../src/types.js";

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
      const results: any[] = [];
      for (const [k, v] of records) {
        if (k.startsWith(`${sessionId}:`)) results.push(v);
      }
      return results;
    },
  };
}

const currentBlocks: CoreMemoryBlock[] = [
  {
    label: "story_state",
    content: "初始状态",
    updatedAt: "2026-01-01T00:00:00Z",
  },
  { label: "scene", content: "初始场景", updatedAt: "2026-01-01T00:00:00Z" },
  {
    label: "character_relationships",
    content: "",
    updatedAt: "2026-01-01T00:00:00Z",
  },
  {
    label: "player_profile",
    content: "玩家资料",
    updatedAt: "2026-01-01T00:00:00Z",
  },
];

describe("createMemorySystem slot resolution", () => {
  let store: ReturnType<typeof createMockStore>;
  let calls: Array<{ model?: string }>;
  let llm: MemoryLLMAdapter;

  beforeEach(() => {
    store = createMockStore();
    calls = [];
    llm = {
      complete: vi.fn(async (params) => {
        calls.push({ model: params.model });
        return { content: '{"scene":"新场景"}' };
      }),
    };
  });

  it("prefers an explicit updater modelSlot over resolver fallback", async () => {
    const system = createMemorySystem(
      {
        store: store as any,
        llm,
        resolveSlot: (slot) =>
          slot === "memory" || slot === "story" ? slot : undefined,
      },
      {
        updater: { modelSlot: "plugin" },
      },
    );

    await system.updater.updateAfterTurn({
      sessionId: "sess-explicit",
      narrativeText: "玩家进入新场景。",
      currentBlocks,
    });

    expect(calls[0]?.model).toBe("plugin");
  });

  it("falls back to the memory slot when no explicit slot is provided", async () => {
    const system = createMemorySystem({
      store: store as any,
      llm,
      resolveSlot: (slot) => (slot === "memory" ? "memory" : undefined),
    });

    await system.updater.updateAfterTurn({
      sessionId: "sess-memory",
      narrativeText: "玩家继续前进。",
      currentBlocks,
    });

    expect(calls[0]?.model).toBe("memory");
  });

  it("does NOT hardcode a 'story' slot fallback — leaves the slot undefined", async () => {
    // Regression guard: the prior implementation baked a magic "story" slot id
    // into the memory package. When only an unrelated slot resolves and the
    // canonical "memory" slot is absent, the model slot must be left undefined
    // so the gateway's own default-slot resolution applies.
    const system = createMemorySystem({
      store: store as any,
      llm,
      resolveSlot: (slot) => (slot === "story" ? "story" : undefined),
    });

    await system.updater.updateAfterTurn({
      sessionId: "sess-no-story",
      narrativeText: "玩家在原地等待。",
      currentBlocks,
    });

    expect(calls[0]?.model).toBeUndefined();
  });
});
