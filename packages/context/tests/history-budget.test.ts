import { describe, it, expect, vi } from "vitest";
import { createMemoryStore, type TurnMessageRecord } from "@covel/store";
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
            messageIds: ids,
            content: "summary",
            focusSections: [],
          }),
        }),
      ).rejects.toThrow("Invalid history compaction");
      expect(await store.listSessionSummaries("s")).toEqual([]);
      expect(await store.listUncompactedTurnMessages("s")).toEqual(messages);
    },
  );
  it("atomically replaces the prior rolling summary and retags history", async () => {
    const store = createMemoryStore();
    const messages = [message("a"), message("b"), message("c")];
    for (const m of messages) await store.appendTurnMessage(m);
    const compact = vi.fn(async () => ({
      messageIds: ["a"],
      content: "first",
      focusSections: [],
    }));
    const deps = {
      store,
      estimator: (s: string) => s.length,
      contextWindow: 100,
      compact,
    };
    await maybeCompact("s", "", messages, deps);
    compact.mockResolvedValue({
      messageIds: ["b"],
      content: "second",
      focusSections: [],
    });
    await maybeCompact(
      "s",
      "",
      await store.listUncompactedTurnMessages("s"),
      deps,
    );
    const summaries = await store.listSessionSummaries("s");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      content: "second",
      turnRangeStart: "a",
      turnRangeEnd: "b",
    });
    expect(await store.listUncompactedTurnMessages("s")).toEqual([messages[2]]);
  });
});
