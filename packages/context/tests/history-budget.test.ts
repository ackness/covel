import { describe, it, expect, vi } from "vitest";
import { type TurnMessageRecord } from "@covel/store";
import { createMemoryStore } from "@covel/store/memory";
import { createSqliteStore } from "@covel/store/sqlite";
import { maybeCompact } from "../src/history-budget.js";

const message = (id: string): TurnMessageRecord => ({
  id,
  sessionId: "s",
  turnId: id,
  sourceType: "player",
  role: "user",
  content: "x".repeat(100),
  order: 0,
  createdAt: "2026-09-27T00:00:00Z",
});
describe("history budget", () => {
  it("does not invoke providers under budget", async () => {
    const compact = vi.fn();
    expect(
      await maybeCompact("s", "", [message("a")], {
        store: createMemoryStore(),
        estimator: (s) => s.length,
        contextWindow: 1000,
        compact,
      }),
    ).toEqual({ compacted: false });
    expect(compact).not.toHaveBeenCalled();
  });
  it.each([["b"], ["foreign"], ["a", "a"], ["b", "a"]])(
    "rejects a non-prefix selection %j before any write",
    async (...ids) => {
      const store = createMemoryStore();
      const messages = [message("a"), message("b")];
      for (const m of messages) await store.appendTurnMessage(m);
      await expect(
        maybeCompact("s", "", messages, {
          store,
          estimator: (s) => s.length,
          contextWindow: 100,
          compact: async () => ({
            summaries: [
              {
                messageIds: ids,
                replacesSummaryIds: [],
                content: "summary",
                focusSections: [],
              },
            ],
          }),
        }),
      ).rejects.toThrow("Invalid history compaction");
      expect(await store.listSessionSummaries("s")).toEqual([]);
      expect(await store.listUncompactedTurnMessages("s")).toEqual(messages);
    },
  );
  it("atomically replaces only the selected old segment and appends fresh history", async () => {
    const store = createMemoryStore();
    const messages = [message("a"), message("b"), message("c")];
    for (const m of messages) await store.appendTurnMessage(m);
    const compact = vi.fn(async () => ({
      summaries: [
        {
          messageIds: ["a"],
          replacesSummaryIds: [] as string[],
          content: "first",
          focusSections: [],
        },
      ],
    }));
    const deps = {
      store,
      estimator: (s: string) => s.length,
      contextWindow: 100,
      compact,
    };
    await maybeCompact("s", "", messages, deps);
    const firstId = (await store.listSessionSummaries("s"))[0]!.id;
    compact.mockResolvedValue({
      summaries: [
        {
          messageIds: [],
          replacesSummaryIds: [firstId],
          content: "merged first",
          focusSections: [],
        },
        {
          messageIds: ["b"],
          replacesSummaryIds: [],
          content: "second",
          focusSections: [],
        },
      ],
    });
    await maybeCompact(
      "s",
      "",
      await store.listUncompactedTurnMessages("s"),
      deps,
    );
    const summaries = await store.listSessionSummaries("s");
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toMatchObject({
      id: firstId,
      content: "merged first",
      turnRangeStart: "a",
      turnRangeEnd: "a",
    });
    expect(summaries[1]).toMatchObject({
      content: "second",
      turnRangeStart: "b",
      turnRangeEnd: "b",
    });
    expect(
      (await store.listTurnMessages("s")).find((m) => m.id === "a")
        ?.compactedAtTurnId,
    ).toBe(firstId);
    expect(await store.listUncompactedTurnMessages("s")).toEqual([messages[2]]);
  });
});

describe.each([
  ["MemoryStore", () => createMemoryStore()],
  ["SqliteStore", () => createSqliteStore(":memory:")],
] as const)("canonical compaction admission on %s", (_name, createStore) => {
  it.each(["filtered", "reordered"])(
    "keeps the canonical log when a %s projection selects a non-prefix",
    async (projection) => {
      const store = createStore();
      try {
        const canonical = [message("a"), message("b"), message("c")];
        for (const row of canonical) await store.appendTurnMessage(row);
        const projected =
          projection === "filtered"
            ? canonical.slice(1)
            : [canonical[1]!, canonical[0]!, canonical[2]!];
        const result = await maybeCompact(
          "s",
          "",
          projected,
          {
            store,
            contextWindow: 1000,
            estimator: (text) => text.length,
            compact: async () => ({
              summaries: [
                {
                  messageIds: ["b"],
                  replacesSummaryIds: [],
                  content: "Event b",
                  focusSections: [],
                },
              ],
            }),
          },
          { threshold: 0 },
        );
        expect(result.compacted).toBe(false);
        expect(await store.listSessionSummaries("s")).toEqual([]);
        expect(await store.listUncompactedTurnMessages("s")).toEqual(canonical);
      } finally {
        await store.close();
      }
    },
  );

  it("rolls back summary writes when message tagging fails", async () => {
    const store = createStore();
    try {
      const canonical = [message("a"), message("b")];
      for (const row of canonical) await store.appendTurnMessage(row);
      const failingStore = {
        ...store,
        withTransaction: <T>(
          fn: Parameters<typeof store.withTransaction<T>>[0],
        ) =>
          store.withTransaction((tx) =>
            fn({
              ...tx,
              tagTurnMessagesCompacted: async () => {
                throw new Error("tag failed");
              },
            }),
          ),
      };
      await expect(
        maybeCompact(
          "s",
          "",
          canonical,
          {
            store: failingStore,
            contextWindow: 1000,
            estimator: (text) => text.length,
            compact: async () => ({
              summaries: [
                {
                  messageIds: ["a"],
                  replacesSummaryIds: [],
                  content: "Event a",
                  focusSections: [],
                },
              ],
            }),
          },
          { threshold: 0 },
        ),
      ).rejects.toThrow("tag failed");
      expect(await store.listSessionSummaries("s")).toEqual([]);
      expect(await store.listUncompactedTurnMessages("s")).toEqual(canonical);
    } finally {
      await store.close();
    }
  });
});
