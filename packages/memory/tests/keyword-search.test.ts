import { expect, it } from "vitest";
import { createKeywordRecallSearcher } from "../src/recall-search.js";
import { createKeywordArchivalSearcher } from "../src/archival-search.js";

it("finds reordered Chinese phrases and returns the matching passage beyond the prefix", async () => {
  const content =
    "无关背景。".repeat(160) + "守门人收下了你的承诺，你说黎明前归来。";
  const query = "回忆黎明前向守门人许下的承诺";
  const recall = createKeywordRecallSearcher({
    listRecentTurnMessages: async () => [
      {
        id: "message",
        sessionId: "session",
        turnId: "turn",
        role: "assistant",
        content,
        createdAt: "2026-10-06T00:00:00Z",
      },
    ],
  });
  const hits = await recall.search("session", query);
  expect(hits).toHaveLength(1);
  expect(hits[0]?.content).toContain("守门人收下了你的承诺");
  expect(hits[0]!.content.length).toBeLessThanOrEqual(502);
  const archival = createKeywordArchivalSearcher({
    listCharacters: async () => [],
    listSessionLorebookEntries: async () => [
      {
        id: "lore",
        sessionId: "session",
        owner: { kind: "world" },
        content,
        keys: [],
        position: "before-character",
        insertionOrder: 0,
        mode: "constant",
        createdAt: "2026-10-06T00:00:00Z",
        updatedAt: "2026-10-06T00:00:00Z",
      },
    ],
  });
  expect((await archival.search("session", query))[0]?.content).toContain(
    "守门人收下了你的承诺",
  );
});
