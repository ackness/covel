import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryUpdater } from "../src/updater.js";
import { createMemoryManager } from "../src/core-memory.js";
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

function createMockLLM(response: string): MemoryLLMAdapter {
  return {
    async complete() {
      return { content: response };
    },
  };
}

describe("MemoryUpdater", () => {
  let store: ReturnType<typeof createMockStore>;
  let manager: ReturnType<typeof createMemoryManager>;
  const currentBlocks: CoreMemoryBlock[] = [
    {
      label: "story_state",
      content: "玩家刚到坊市",
      updatedAt: "2026-01-01T00:00:00Z",
    },
    { label: "scene", content: "坊市", updatedAt: "2026-01-01T00:00:00Z" },
    {
      label: "character_relationships",
      content: "",
      updatedAt: "2026-01-01T00:00:00Z",
    },
    {
      label: "player_profile",
      content: "练气三层",
      updatedAt: "2026-01-01T00:00:00Z",
    },
  ];

  beforeEach(() => {
    store = createMockStore();
    manager = createMemoryManager(store as any);
  });

  it("should parse JSON response and update blocks", async () => {
    const llm = createMockLLM(
      JSON.stringify({
        scene: "百灵沼泽入口，黄昏时分",
        story_state: "玩家和苏婉出发前往百灵沼泽",
      }),
    );

    const updater = createMemoryUpdater(manager, llm);
    const result = await updater.updateAfterTurn({
      sessionId: "sess-1",
      narrativeText: "你和苏婉离开坊市...",
      currentBlocks,
    });

    expect(result.updated).toBe(true);
    expect(result.blocksChanged).toContain("scene");
    expect(result.blocksChanged).toContain("story_state");
    expect(result.blocksChanged).toHaveLength(2);

    const scene = await manager.getBlock("sess-1", "scene");
    expect(scene!.content).toBe("百灵沼泽入口，黄昏时分");
  });

  it("injects committed character and form values as authoritative facts", async () => {
    let captured: Parameters<MemoryLLMAdapter["complete"]>[0] | undefined;
    const llm: MemoryLLMAdapter = {
      async complete(request) {
        captured = request;
        return { content: "{}" };
      },
    };
    const updater = createMemoryUpdater(manager, llm);

    await updater.updateAfterTurn({
      sessionId: "sess-authoritative",
      narrativeText: "叙事没有复述角色创建表单。",
      authoritativeFacts: {
        playerCharacter: {
          name: "阿砾",
          type: "player",
          fields: { carapaceSense: "甲感略强于常人", socialStyle: "会来事" },
        },
        lastFormValues: {
          carapaceSense: "甲感略强于常人",
          socialStyle: "会来事",
        },
      },
      currentBlocks,
    });

    expect(captured?.systemPrompt).toContain("必须以会话事实为准");
    const userPrompt = String(captured?.messages[0]?.content ?? "");
    expect(userPrompt).toContain("## 会话事实（权威）");
    expect(userPrompt).toContain('"carapaceSense": "甲感略强于常人"');
    expect(userPrompt).toContain('"socialStyle": "会来事"');
  });

  it("deterministically preserves confirmed player fields across later turns", async () => {
    const responses = [
      {
        player_profile:
          "身份：拾荒学徒。姓名：阿砾。壳感二分，谈锋圆滑。当前状态：已进入尖塔。",
      },
      {
        player_profile:
          "姓名：阿砾；甲觉二分；谈锋圆滑。当前状态：继续沿旋梯下行。",
      },
    ];
    const llm: MemoryLLMAdapter = {
      async complete() {
        return { content: JSON.stringify(responses.shift() ?? {}) };
      },
    };
    const updater = createMemoryUpdater(manager, llm);
    const authoritativeFacts = {
      playerCharacter: {
        name: "阿砾",
        type: "player",
        fields: { shellSense: "二分", tongue: "圆滑" },
      },
      playerFieldLabels: { shellSense: "甲感", tongue: "谈锋" },
      lastFormValues: { shellSense: "二分", tongue: "圆滑" },
    } as const;

    await updater.updateAfterTurn({
      sessionId: "sess-stable-profile",
      narrativeText: "玩家进入尖塔。",
      authoritativeFacts,
      currentBlocks,
    });
    const afterFirst = await manager.loadBlocks("sess-stable-profile");
    const firstProfile = afterFirst.find(
      (block) => block.label === "player_profile",
    )?.content;
    expect(firstProfile).toContain(
      "角色资料（已确认）：姓名：阿砾；甲感：二分；谈锋：圆滑。",
    );
    expect(firstProfile).toContain("当前状态：已进入尖塔。");
    expect(firstProfile).not.toContain("壳感");

    await updater.updateAfterTurn({
      sessionId: "sess-stable-profile",
      narrativeText: "玩家继续下行。",
      authoritativeFacts,
      currentBlocks: afterFirst,
    });
    const afterSecond = await manager.getBlock(
      "sess-stable-profile",
      "player_profile",
    );
    expect(afterSecond?.content).toContain(
      "角色资料（已确认）：姓名：阿砾；甲感：二分；谈锋：圆滑。",
    );
    expect(afterSecond?.content).toContain("当前状态：继续沿旋梯下行。");
    expect(afterSecond?.content).not.toContain("甲觉");
  });

  it("persists confirmed player fields before a slow summarizer completes", async () => {
    let releaseLlm!: () => void;
    let markLlmStarted!: () => void;
    const llmStarted = new Promise<void>((resolve) => {
      markLlmStarted = resolve;
    });
    const llmReleased = new Promise<void>((resolve) => {
      releaseLlm = resolve;
    });
    const slowLlm: MemoryLLMAdapter = {
      async complete() {
        markLlmStarted();
        await llmReleased;
        return { content: "{}" };
      },
    };
    const updater = createMemoryUpdater(manager, slowLlm);
    const update = updater.updateAfterTurn({
      sessionId: "sess-early-profile",
      narrativeText: "摘要调用仍在进行。",
      authoritativeFacts: {
        playerCharacter: {
          name: "阿砾",
          type: "player",
          fields: { shellSense: "二分" },
        },
        playerFieldLabels: { shellSense: "甲感" },
      },
      currentBlocks: currentBlocks.map((block) =>
        block.label === "player_profile"
          ? { ...block, content: "姓名：阿砾。壳感二分。" }
          : block,
      ),
    });

    await llmStarted;
    const whileLlmPending = await manager.getBlock(
      "sess-early-profile",
      "player_profile",
    );
    expect(whileLlmPending?.content).toContain(
      "角色资料（已确认）：姓名：阿砾；甲感：二分。",
    );
    expect(whileLlmPending?.content).not.toContain("壳感");

    releaseLlm();
    await expect(update).resolves.toMatchObject({
      updated: true,
      blocksChanged: ["player_profile"],
    });
  });

  it("should handle markdown-wrapped JSON", async () => {
    const llm = createMockLLM('```json\n{"scene": "新场景"}\n```');
    const updater = createMemoryUpdater(manager, llm);
    const result = await updater.updateAfterTurn({
      sessionId: "sess-1",
      narrativeText: "...",
      currentBlocks,
    });

    expect(result.updated).toBe(true);
    expect(result.blocksChanged).toEqual(["scene"]);
  });

  it("should handle empty response (no updates needed)", async () => {
    const llm = createMockLLM("{}");
    const updater = createMemoryUpdater(manager, llm);
    const result = await updater.updateAfterTurn({
      sessionId: "sess-1",
      narrativeText: "一切平静...",
      currentBlocks,
    });

    expect(result.updated).toBe(false);
    expect(result.blocksChanged).toHaveLength(0);
  });

  it("should handle malformed LLM output gracefully", async () => {
    const llm = createMockLLM("I am confused, here is no JSON");
    const updater = createMemoryUpdater(manager, llm);
    const result = await updater.updateAfterTurn({
      sessionId: "sess-1",
      narrativeText: "...",
      currentBlocks,
    });

    expect(result.updated).toBe(false);
    expect(result.blocksChanged).toHaveLength(0);
  });

  it("should handle LLM call failure gracefully", async () => {
    const llm: MemoryLLMAdapter = {
      async complete() {
        throw new Error("LLM timeout");
      },
    };
    const updater = createMemoryUpdater(manager, llm);
    const result = await updater.updateAfterTurn({
      sessionId: "sess-1",
      narrativeText: "...",
      currentBlocks,
    });

    expect(result.updated).toBe(false);
    expect(result.error).toBe("LLM timeout");
  });

  it("should ignore invalid block labels in response", async () => {
    const llm = createMockLLM(
      JSON.stringify({
        scene: "有效更新",
        invalid_label: "这个应该被忽略",
      }),
    );
    const updater = createMemoryUpdater(manager, llm);
    const result = await updater.updateAfterTurn({
      sessionId: "sess-1",
      narrativeText: "...",
      currentBlocks,
    });

    expect(result.blocksChanged).toEqual(["scene"]);
  });

  describe("awaitPending — prevents next-turn races", () => {
    it("resolves immediately when no update is pending", async () => {
      const llm = createMockLLM("{}");
      const updater = createMemoryUpdater(manager, llm);
      await expect(updater.awaitPending("sess-fresh")).resolves.toBeUndefined();
    });

    it("blocks until the fire-and-forget updateAfterTurn has finished writing", async () => {
      let resolveLlm: () => void;
      const llmDone = new Promise<void>((r) => {
        resolveLlm = r;
      });
      const slowLlm: MemoryLLMAdapter = {
        async complete() {
          await llmDone;
          return {
            content: JSON.stringify({ scene: "written-after-pending-await" }),
          };
        },
      };

      const updater = createMemoryUpdater(manager, slowLlm);
      // Fire-and-forget — do not await.
      const fire = updater.updateAfterTurn({
        sessionId: "sess-race",
        narrativeText: "turn 1",
        currentBlocks,
      });

      // Pre-condition: block has not been written yet.
      const before = await manager.getBlock("sess-race", "scene");
      expect(before?.content).not.toBe("written-after-pending-await");

      // Let the LLM respond and the update finish.
      resolveLlm!();
      await updater.awaitPending("sess-race");

      const after = await manager.getBlock("sess-race", "scene");
      expect(after?.content).toBe("written-after-pending-await");

      // Also ensure the original promise resolved.
      const fireResult = await fire;
      expect(fireResult.blocksChanged).toEqual(["scene"]);
    });

    it("serialises back-to-back updateAfterTurn calls for the same session", async () => {
      const order: string[] = [];
      let step = 0;
      const sequenced: MemoryLLMAdapter = {
        async complete() {
          const me = ++step;
          order.push(`start-${me}`);
          await new Promise((r) => setTimeout(r, 20));
          order.push(`end-${me}`);
          return { content: JSON.stringify({ scene: `content-${me}` }) };
        },
      };

      const updater = createMemoryUpdater(manager, sequenced);
      const p1 = updater.updateAfterTurn({
        sessionId: "sess-seq",
        narrativeText: "t1",
        currentBlocks,
      });
      const p2 = updater.updateAfterTurn({
        sessionId: "sess-seq",
        narrativeText: "t2",
        currentBlocks,
      });

      await Promise.all([p1, p2]);

      // Each call must complete before the next starts — never interleaved.
      expect(order).toEqual(["start-1", "end-1", "start-2", "end-2"]);
    });
  });
});
