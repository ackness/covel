import { expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import type { TurnMessageRecord } from "@covel/store";
import {
  maybeCompact as applyCompaction,
  type PromptLoader,
} from "@covel/context";

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

import {
  compactHistory,
  type CompactorLLMAdapter,
  type CompactionPolicyOptions,
} from "../server/strategy.js";
import type { CompactorDeps, CompactorOptions } from "@covel/context";
async function maybeCompact(
  sessionId: string,
  system: string,
  messages: readonly TurnMessageRecord[],
  deps: Omit<CompactorDeps, "compact"> & {
    fastSlotLlm: CompactorLLMAdapter;
    loadPrompt: PromptLoader;
  },
  opts: CompactorOptions & CompactionPolicyOptions,
) {
  return applyCompaction(
    sessionId,
    system,
    messages,
    { ...deps, compact: (input) => compactHistory(input, deps, opts) },
    opts,
  );
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
          inputWindow: 10_000,
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
        inputWindow: 10_000,
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

it.each(["length", "max_tokens"])(
  "keeps raw history when the gateway summary ends with %s",
  async (finishReason) => {
    const { default: register } = await import("../server/index.js");
    let handler;
    register({
      provideExtension(_point, _id, registration) {
        handler = registration.handler;
      },
    });
    const store = createMemoryStore();
    const messages = Array.from({ length: 10 }, (_, index) => ({
      ...history("truncated")[0]!,
      id: `message-${index}`,
      turnId: `turn-${index}`,
      role: index % 2 ? "assistant" : "user",
      createdAt: new Date(index).toISOString(),
    }));
    for (const message of messages) await store.appendTurnMessage(message);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await applyCompaction(
        "truncated",
        "",
        messages,
        {
          store,
          estimator: (text) => text.length,
          contextWindow: 10000,
          inputWindow: 20000,
          compact: (input) =>
            handler(input, {
              signal: new AbortController().signal,
              gateway: {
                generateText: async () => ({
                  text: "An unfinished summary",
                  finishReason,
                }),
              },
            }),
        },
        { threshold: 0 },
      );
      expect(result.compacted).toBe(false);
      expect(await store.listSessionSummaries("truncated")).toEqual([]);
      expect(await store.listUncompactedTurnMessages("truncated")).toEqual(
        messages,
      );
    } finally {
      warn.mockRestore();
    }
  },
);
