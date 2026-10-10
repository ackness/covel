import { expect, it } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import type { LorebookEntryRecord } from "@covel/store";
import { createKeywordRecallSearcher } from "../src/recall-search.js";
import { createKeywordArchivalSearcher } from "../src/archival-search.js";
import { characterItems } from "../src/archival-items.js";

it("finds reordered Chinese phrases and returns the matching passage beyond the prefix", async () => {
  const content =
    "无关背景。".repeat(160) + "守门人收下了你的承诺，你说黎明前归来。";
  const query = "回忆黎明前向守门人许下的承诺";
  const recall = createKeywordRecallSearcher({
    listSessionSummaries: async () => [],
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
    listPluginData: async () => [],
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

it.each(["Alice", "alice", "灯塔"])(
  "finds a message where a Latin name touches Chinese text: %s",
  async (query) => {
    const message = (id: string, content: string) => ({
      id,
      sessionId: "session",
      turnId: "turn",
      role: "assistant" as const,
      content,
      createdAt: "2026-10-06T00:00:00Z",
    });
    const recall = createKeywordRecallSearcher({
      listSessionSummaries: async () => [],
      listRecentTurnMessages: async () => [
        message("target", "Alice去了北方的灯塔"),
        message("other", "守门人收下了你的承诺"),
      ],
    });
    const hits = await recall.search("session", query);
    expect(hits.map((hit) => hit.content)).toEqual(["Alice去了北方的灯塔"]);
    expect(hits[0]?.score).toBeGreaterThan(0.1);
  },
);

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

const turnMessage = (order: number, content: string) => ({
  id: `m-${order}`,
  sessionId: "session",
  turnId: `t-${order}`,
  sourceType: "runtime",
  role: "assistant",
  content,
  order,
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, order)).toISOString(),
});

it("ranks the message with the rare name above messages that share only common words", async () => {
  const recall = createKeywordRecallSearcher({
    listSessionSummaries: async () => [],
    listRecentTurnMessages: async () => [
      turnMessage(1, "你走进酒馆，一个男人坐在角落里喝酒。"),
      turnMessage(2, "一个男人向你打听去码头的路。"),
      turnMessage(3, "戴红围巾的男人把一封信塞进你手里，转身消失在雨中。"),
      turnMessage(4, "一个男人在街上叫卖热汤。"),
    ],
  });
  const hits = await recall.search("session", "那个戴红围巾的男人给了我什么");
  expect(hits[0]?.content).toContain("红围巾");
  expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
});

it("finds a turn that only a history summary still describes", async () => {
  const recall = createKeywordRecallSearcher({
    listRecentTurnMessages: async () => [
      turnMessage(900, "你在集市上买了一袋面粉。"),
    ],
    listSessionSummaries: async () => [
      {
        id: "summary",
        sessionId: "session",
        turnRangeStart: "t-1",
        turnRangeEnd: "t-40",
        content: "你答应守门人在黎明前带回银钥匙，他给了你一盏提灯。",
        focusSections: [],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  });
  const hits = await recall.search("session", "我答应过守门人什么");
  expect(hits[0]).toMatchObject({ role: "summary", turnId: "t-40" });
  expect(hits[0]?.content).toContain("银钥匙");
});

it("searches only the plugin data that an active plugin declared searchable", async () => {
  const store = createMemoryStore();
  const now = "2026-01-01T00:00:00.000Z";
  const row = (namespace: string, key: string, value: unknown) => ({
    id: `${namespace}-${key}`,
    sessionId: "session",
    pluginId: "journal",
    namespace,
    key,
    value,
    createdAt: now,
    updatedAt: now,
  });
  await store.setPluginDataBatch([
    row("facts", "t00003-1", {
      turn: 3,
      text: "第3回合：林遥把银钥匙藏在钟楼的第三级台阶下。",
    }),
    row("facts", "broken", { turn: 4 }),
    row("private", "note", { text: "银钥匙的真正主人是市长。" }),
  ]);
  try {
    const declared = createKeywordArchivalSearcher(store, async () => [
      { pluginId: "journal", namespace: "facts", textField: "text" },
    ]);
    expect(await declared.search("session", "银钥匙在哪里")).toEqual([
      expect.objectContaining({
        source: "plugin_data",
        pluginId: "journal",
        namespace: "facts",
        key: "t00003-1",
        content: "第3回合：林遥把银钥匙藏在钟楼的第三级台阶下。",
      }),
    ]);
    // Without a declaration no plugin data is read at all.
    expect(
      await createKeywordArchivalSearcher(store).search("session", "银钥匙"),
    ).toEqual([]);
  } finally {
    await store.close();
  }
});

it("indexes character fields without their bookkeeping", async () => {
  const store = createMemoryStore();
  const now = "2026-01-01T00:00:00.000Z";
  await store.upsertCharacter({
    id: "character",
    sessionId: "session",
    name: "Aldric",
    type: "npc",
    description: "keeper",
    fields: {
      mood: "calm",
      lastSeen: {
        turnId: "0b6f6a2e-3c1d-4f5a-9b7e-1a2b3c4d5e6f",
        at: "north gate",
        updatedAt: now,
      },
    },
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  try {
    const [item] = await characterItems(store, "session");
    expect(item?.text).toContain("north gate");
    expect(item?.text).not.toContain("0b6f6a2e");
    expect(item?.text).not.toContain(now);
  } finally {
    await store.close();
  }
});
