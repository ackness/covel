import { expect, it, vi } from "vitest";
import { createMemoryStore, type TurnMessageRecord } from "@covel/store";
import { maybeCompact, type PromptLoader } from "../src/index.js";

function history(sessionId: string): TurnMessageRecord[] {
  return [
    {
      id: "message",
      sessionId,
      turnId: "turn",
      sourceType: "player",
      role: "user",
      content: "Long conversation. ".repeat(100),
      order: 0,
      createdAt: "2026-09-18T00:00:00.000Z",
    },
  ];
}

const options = {
  protectLastNUserTurns: 0,
  protectLastNMessages: 0,
  locale: "en-US",
  focusSections: ["relationships"],
};

it("uses each consumer's injected source through compaction and persistence", async () => {
  await Promise.all(
    ["first", "second"].map(async (owner) => {
      const store = createMemoryStore();
      const messages = history(owner);
      await store.appendTurnMessage(messages[0]!);
      const loader = vi.fn<PromptLoader>(
        async () => `${owner}: {{ sections }}`,
      );
      const complete = vi.fn(async () => ({ content: `${owner} summary` }));
      const result = await maybeCompact(
        owner,
        "",
        messages,
        {
          store,
          estimator: (text) => text.length,
          contextWindow: 100,
          fastSlotLlm: { complete },
          loadPrompt: loader,
        },
        options,
      );
      expect(result.compacted).toBe(true);
      expect(loader).toHaveBeenCalledWith("server", "compactor", "en-US");
      expect(complete).toHaveBeenCalledWith(
        expect.objectContaining({
          systemPrompt: expect.stringContaining(`${owner}: relationships`),
        }),
      );
      expect(await store.listSessionSummaries(owner)).toEqual([
        expect.objectContaining({ content: `${owner} summary` }),
      ]);
    }),
  );
});

it("preserves history when the injected template source fails", async () => {
  const store = createMemoryStore();
  const messages = history("session");
  await store.appendTurnMessage(messages[0]!);
  const complete = vi.fn(async () => ({ content: "summary" }));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const result = await maybeCompact(
      "session",
      "",
      messages,
      {
        store,
        estimator: (text) => text.length,
        contextWindow: 100,
        fastSlotLlm: { complete },
        loadPrompt: async () => {
          throw new Error("Unavailable template source");
        },
      },
      options,
    );
    expect(result.compacted).toBe(false);
    expect(complete).not.toHaveBeenCalled();
    expect(await store.listSessionSummaries("session")).toEqual([]);
    expect(await store.listUncompactedTurnMessages("session")).toEqual(
      messages,
    );
  } finally {
    warn.mockRestore();
  }
});
