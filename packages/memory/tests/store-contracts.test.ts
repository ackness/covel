import { describe, expect, it } from "vitest";
import { createKeywordRecallSearcher } from "../src/recall-search.js";
import { createKeywordArchivalSearcher } from "../src/archival-search.js";
import { createVectorRecallSearcher } from "../src/vector-recall-search.js";

describe("memory tier storage adapters", () => {
  it("searches recall with only the recent-message reader", async () => {
    const searcher = createKeywordRecallSearcher({
      listRecentTurnMessages: async () => [
        {
          id: "message",
          sessionId: "session",
          turnId: "turn",
          sourceType: "player",
          role: "user",
          content: "A sapphire compass",
          order: 0,
          createdAt: "today",
        },
      ],
    });
    expect(await searcher.search("session", "sapphire", 1)).toEqual([
      expect.objectContaining({
        content: "A sapphire compass",
        turnId: "turn",
      }),
    ]);
  });

  it("searches archival character facts with only lorebook and character readers", async () => {
    const searcher = createKeywordArchivalSearcher({
      listSessionLorebookEntries: async () => [],
      listCharacters: async () => [
        {
          id: "character",
          sessionId: "session",
          name: "Captain",
          type: "npc",
          fields: { equipment: "sapphire compass" },
          version: 1,
          createdAt: "today",
          updatedAt: "today",
        },
      ],
    });
    expect(await searcher.search("session", "sapphire", 1)).toEqual([
      expect.objectContaining({ source: "character", key: "Captain" }),
    ]);
  });

  it("uses a vector-only adapter without requiring a domain database", async () => {
    const searcher = createVectorRecallSearcher({
      store: {
        upsertVector: async () => {},
        deleteVectors: async () => {},
        ensureVectorModel: async () => {},
        listVectorModels: async () => [],
        resolveSessionVectorTarget: async () => ({
          modelRegistryId: 1,
          modelId: "test",
          dim: 2,
          tableName: "test",
        }),
        searchVectors: async () => [
          {
            sessionId: "session",
            pluginId: "memory",
            namespace: "recall",
            key: "message",
            distance: 0,
            payload: JSON.stringify({
              turnId: "turn",
              role: "assistant",
              content: "A sapphire compass",
              createdAt: "today",
            }),
          },
        ],
      },
      embed: async () => [new Float32Array([1, 0])],
      fallback: {
        search: async () => {
          throw new Error("unexpected fallback");
        },
      },
    });
    expect(await searcher.search("session", "sapphire", 1)).toEqual([
      expect.objectContaining({
        content: "A sapphire compass",
        turnId: "turn",
      }),
    ]);
  });
});
