import { expect, it } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import type { LorebookEntryRecord } from "@covel/store";
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
        position: "before",
        insertionOrder: 0,
        strategy: "constant",
        enabled: true,
        createdAt: "2026-10-06T00:00:00Z",
        updatedAt: "2026-10-06T00:00:00Z",
      },
    ],
  });
  expect((await archival.search("session", query))[0]?.content).toContain(
    "守门人收下了你的承诺",
  );
});

it("excludes disabled lorebook through true→false→true without muting other owners or characters", async () => {
  const store = createMemoryStore();
  const now = "2026-01-01T00:00:00.000Z";
  const entry: LorebookEntryRecord = {
    id: "shared-id",
    sessionId: "session",
    owner: { kind: "plugin", pluginId: "owner-a" },
    keys: ["muted-forge"],
    content: "blacksmith forge knowledge",
    strategy: "selective",
    position: "before",
    insertionOrder: 0,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
  await store.upsertLorebookEntries([
    entry,
    { ...entry, owner: { kind: "world" }, keys: ["world-forge"] },
    { ...entry, owner: { kind: "player" }, keys: ["player-forge"] },
    {
      ...entry,
      owner: { kind: "plugin", pluginId: "owner-b" },
      keys: ["other-forge"],
    },
    { ...entry, sessionId: "other-session", keys: ["foreign-forge"] },
  ]);
  await store.upsertCharacter({
    id: "character",
    sessionId: "session",
    name: "Aldric",
    type: "npc",
    description: "blacksmith forge keeper",
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  const searcher = createKeywordArchivalSearcher(store);
  try {
    for (const enabled of [true, false, true]) {
      await store.upsertLorebookEntries([{ ...entry, enabled }]);
      const hits = await searcher.search("session", "blacksmith forge");
      expect(hits.map((hit) => hit.key).sort()).toEqual(
        [
          "Aldric",
          "other-forge",
          "player-forge",
          "world-forge",
          ...(enabled ? ["muted-forge"] : []),
        ].sort(),
      );
      expect(hits.find((hit) => hit.key === "other-forge")?.pluginId).toBe(
        "owner-b",
      );
      expect(hits.find((hit) => hit.key === "muted-forge")?.pluginId).toBe(
        enabled ? "owner-a" : undefined,
      );
    }
  } finally {
    await store.close();
  }
});
