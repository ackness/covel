import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store";
import { createMemoryManager } from "../src/core-memory.js";
import { createMemoryUpdater } from "../src/updater.js";
import { createKeywordArchivalSearcher } from "../src/archival-search.js";
import type { MemoryLLMAdapter } from "../src/types.js";

const input = {
  sessionId: "session",
  turnId: "turn",
  narrativeText: "The player entered the harbor.",
  currentBlocks: [],
};

describe("memory update consistency", () => {
  it.each([
    "not JSON",
    "{broken}",
    "[]",
    "null",
    "42",
    '{"scene":42}',
    '{"scene":""}',
    '{"unknown":"content"}',
  ])(
    "reports invalid output instead of a successful no-op: %s",
    async (content) => {
      const manager = createMemoryManager(createMemoryStore());
      const observer = vi.fn();
      const updater = createMemoryUpdater(
        manager,
        {
          complete: async () => ({ content }),
        },
        { onUpdate: observer },
      );
      const result = await updater.updateAfterTurn(input);
      expect(result).toMatchObject({
        updated: false,
        blocksChanged: [],
        error: expect.any(String),
      });
      expect(observer).toHaveBeenCalledWith(input, result);
      expect(
        (await manager.loadBlocks(input.sessionId)).every(
          (block) => !block.content,
        ),
      ).toBe(true);
    },
  );

  it("accepts an explicit no-op and ignores unknown labels alongside valid blocks", async () => {
    const manager = createMemoryManager(createMemoryStore());
    const complete = vi
      .fn<MemoryLLMAdapter["complete"]>()
      .mockResolvedValueOnce({ content: "{}" })
      .mockResolvedValueOnce({
        content: '{"scene":"harbor","unknown":"ignored"}',
      });
    const updater = createMemoryUpdater(manager, { complete });
    expect(await updater.updateAfterTurn(input)).toEqual({
      updated: false,
      blocksChanged: [],
    });
    expect(await updater.updateAfterTurn(input)).toEqual({
      updated: true,
      blocksChanged: ["scene"],
    });
    expect((await manager.getBlock(input.sessionId, "scene"))?.content).toBe(
      "harbor",
    );
  });

  it("refreshes queued snapshots while keeping each request's adapter and model", async () => {
    const manager = createMemoryManager(createMemoryStore());
    await manager.updateBlock(input.sessionId, "scene", "old scene");
    const staleBlocks = await manager.loadBlocks(input.sessionId);
    const firstResponse = Promise.withResolvers<{ content: string }>();
    const first = { complete: vi.fn(() => firstResponse.promise) };
    const second = {
      complete: vi
        .fn<MemoryLLMAdapter["complete"]>()
        .mockResolvedValue({ content: "{}" }),
    };
    const updater = createMemoryUpdater(manager, first);
    const a = updater.updateAfterTurn({
      ...input,
      currentBlocks: staleBlocks,
      modelSlot: "slot-a",
    });
    const b = updater.updateAfterTurn(
      { ...input, currentBlocks: staleBlocks, modelSlot: "slot-b" },
      second,
    );
    await vi.waitFor(() => expect(first.complete).toHaveBeenCalledOnce());
    expect(second.complete).not.toHaveBeenCalled();
    firstResponse.resolve({ content: '{"scene":"new scene"}' });
    await Promise.all([a, b, updater.awaitPending(input.sessionId)]);
    expect(second.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "slot-b",
        messages: [
          expect.objectContaining({
            content: expect.stringContaining("new scene"),
          }),
        ],
      }),
    );
    expect(
      second.complete.mock.calls[0]![0].messages[0]!.content,
    ).not.toContain("old scene");
  });

  it("includes observation in the pending barrier without failing an already saved update", async () => {
    const manager = createMemoryManager(createMemoryStore());
    const observed = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const warning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    try {
      const updater = createMemoryUpdater(
        manager,
        {
          complete: async () => ({ content: '{"scene":"harbor"}' }),
        },
        {
          onUpdate: async () => {
            started.resolve();
            await observed.promise;
            throw new Error("observer unavailable");
          },
        },
      );
      const update = updater.updateAfterTurn(input);
      await started.promise;
      let drained = false;
      const pending = updater.awaitPending(input.sessionId).then(() => {
        drained = true;
      });
      await Promise.resolve();
      expect(drained).toBe(false);
      observed.resolve();
      expect(await update).toEqual({ updated: true, blocksChanged: ["scene"] });
      await pending;
      expect(drained).toBe(true);
      expect(warning).toHaveBeenCalledOnce();
    } finally {
      warning.mockRestore();
    }
  });
});

it("returns the character fields that caused an archival keyword match", async () => {
  const store = createMemoryStore();
  const now = new Date().toISOString();
  await store.upsertCharacter({
    id: "character",
    sessionId: "session",
    name: "River",
    type: "npc",
    description: "A quiet traveler.",
    fields: { profession: "cartographer" },
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  const hits = await createKeywordArchivalSearcher(store).search(
    "session",
    "cartographer",
  );
  expect(hits).toEqual([
    expect.objectContaining({
      source: "character",
      key: "River",
      content: expect.stringContaining('"profession":"cartographer"'),
    }),
  ]);
  expect(
    await createKeywordArchivalSearcher(store).search("other", "cartographer"),
  ).toEqual([]);
});
