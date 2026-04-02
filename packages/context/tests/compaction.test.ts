import { describe, it, expect } from "vitest";
import {
  estimateTokens,
  needsCompaction,
  compactChatHistory,
} from "../src/compaction/compactor.js";
import { buildRehydratedHistory } from "../src/compaction/rehydrator.js";
import type { TextMessage } from "@covel/ai-provider";

function makeMessages(count: number, contentSize = 100): TextMessage[] {
  const messages: TextMessage[] = [];
  for (let i = 0; i < count; i++) {
    const role = i % 2 === 0 ? "user" : "assistant";
    messages.push({
      role,
      content: `Message ${i}: ${"x".repeat(contentSize)}`,
    });
  }
  return messages;
}

describe("estimateTokens", () => {
  it("estimates ~4 chars per token", () => {
    const messages: TextMessage[] = [
      { role: "user", content: "a".repeat(400) },
    ];
    expect(estimateTokens(messages)).toBe(100);
  });

  it("sums across all messages", () => {
    const messages: TextMessage[] = [
      { role: "user", content: "a".repeat(200) },
      { role: "assistant", content: "b".repeat(200) },
    ];
    expect(estimateTokens(messages)).toBe(100);
  });
});

describe("needsCompaction", () => {
  it("returns false when under threshold", () => {
    const messages = makeMessages(5, 100);
    expect(needsCompaction(messages, { tokenThreshold: 10000 })).toBe(false);
  });

  it("returns true when over threshold", () => {
    const messages = makeMessages(100, 500);
    expect(needsCompaction(messages, { tokenThreshold: 1000 })).toBe(true);
  });
});

describe("compactChatHistory", () => {
  it("preserves recent messages", async () => {
    const messages = makeMessages(20, 100);
    const result = await compactChatHistory(messages, {
      preserveRecentCount: 5,
    });

    expect(result.preservedMessages).toHaveLength(5);
    // Last 5 messages should match original last 5
    for (let i = 0; i < 5; i++) {
      expect(result.preservedMessages[i].content).toContain(
        `Message ${15 + i}`
      );
    }
  });

  it("generates a summary for compacted messages", async () => {
    const messages = makeMessages(20, 100);
    const result = await compactChatHistory(messages, {
      preserveRecentCount: 5,
    });

    expect(result.summary).toBeTruthy();
    expect(result.summary).toContain("Compacted");
    expect(result.stage).toBe("structural");
  });

  it("truncates oversized messages in preserved set", async () => {
    const messages: TextMessage[] = [
      { role: "user", content: "Short" },
      { role: "assistant", content: "x".repeat(10_000) },
    ];

    const result = await compactChatHistory(messages, {
      preserveRecentCount: 10,
      truncateMessageChars: 2000,
    });

    const longMsg = result.preservedMessages.find(
      (m) => m.role === "assistant"
    );
    expect(longMsg).toBeDefined();
    expect(longMsg!.content.length).toBeLessThan(10_000);
    expect(longMsg!.content).toContain("[... content truncated ...]");
    expect(result.stats.truncated).toBe(1);
  });

  it("provides rehydration bundle with state", async () => {
    const messages = makeMessages(20);
    const state = { health: 100, gold: 50 };

    const result = await compactChatHistory(
      messages,
      { preserveRecentCount: 5 },
      { state, phase: "playing" }
    );

    expect(result.rehydration.state).toEqual(state);
    expect(result.rehydration.phase).toBe("playing");
  });

  it("provides correct stats", async () => {
    const messages = makeMessages(30, 100);
    const result = await compactChatHistory(messages, {
      preserveRecentCount: 10,
    });

    expect(result.stats.originalCount).toBe(30);
    expect(result.stats.resultCount).toBe(10);
    expect(result.stats.removed).toBe(20);
    expect(result.stats.tokensAfter).toBeLessThan(result.stats.tokensBefore);
  });

  it("uses LLM summarizer when provided", async () => {
    const messages = makeMessages(20, 100);
    const summarizer = async (_text: string) => "LLM generated summary";

    const result = await compactChatHistory(
      messages,
      { preserveRecentCount: 5 },
      undefined,
      summarizer
    );

    expect(result.summary).toBe("LLM generated summary");
    expect(result.stage).toBe("llm-summary");
  });

  it("falls back to structural summary on LLM failure", async () => {
    const messages = makeMessages(20, 100);
    const summarizer = async (_text: string) => {
      throw new Error("LLM unavailable");
    };

    const result = await compactChatHistory(
      messages,
      { preserveRecentCount: 5 },
      undefined,
      summarizer
    );

    expect(result.summary).toContain("Compacted");
    expect(result.stage).toBe("llm-summary");
  });

  it("handles empty input", async () => {
    const result = await compactChatHistory([]);
    expect(result.preservedMessages).toHaveLength(0);
    expect(result.stats.originalCount).toBe(0);
  });

  it("handles input smaller than preserveRecentCount", async () => {
    const messages = makeMessages(3, 100);
    const result = await compactChatHistory(messages, {
      preserveRecentCount: 10,
    });

    expect(result.preservedMessages).toHaveLength(3);
    expect(result.stats.removed).toBe(0);
  });

  it("does not mutate original messages", async () => {
    const messages = makeMessages(5, 5000);
    const origContents = messages.map((m) => m.content);

    await compactChatHistory(messages, {
      preserveRecentCount: 3,
      truncateMessageChars: 2000,
    });

    expect(messages.map((m) => m.content)).toEqual(origContents);
  });
});

describe("buildRehydratedHistory", () => {
  it("includes compaction summary and preserved messages", () => {
    const compacted = {
      summary: "Previously, the hero explored a cave.",
      recentMessages: [
        { role: "user" as const, content: "I open the chest" },
        { role: "assistant" as const, content: "The chest contains gold" },
      ],
    };

    const result = buildRehydratedHistory(compacted, { gold: 50 }, []);

    // Should have: rehydration user + ack assistant + 2 preserved = 4
    expect(result.length).toBeGreaterThanOrEqual(4);
    expect(result[0].role).toBe("user");
    expect(result[0].content).toContain("compaction_summary");
    expect(result[0].content).toContain("hero explored a cave");
    // Last messages should be the preserved ones
    expect(result[result.length - 1].content).toBe(
      "The chest contains gold"
    );
  });

  it("includes state and character snapshots", () => {
    const compacted = {
      summary: "Summary",
      recentMessages: [{ role: "user" as const, content: "Hello" }],
    };
    const characters = [
      {
        id: "char1",
        worldId: "w1",
        runId: "r1",
        name: "Hero",
        type: "player" as const,
        description: "A brave adventurer",
        createdAt: "2026-01-01",
        version: 1,
        fields: {},
        extensions: {},
      },
    ];

    const result = buildRehydratedHistory(
      compacted,
      { health: 100 },
      characters
    );

    expect(result[0].content).toContain("current_state_snapshot");
    expect(result[0].content).toContain("health");
    expect(result[0].content).toContain("active_characters_snapshot");
    expect(result[0].content).toContain("Hero");
  });

  it("handles empty compaction (no summary)", () => {
    const compacted = {
      summary: "",
      recentMessages: [{ role: "user" as const, content: "Hello" }],
    };

    const result = buildRehydratedHistory(compacted, {}, []);

    // Should only have the preserved messages (no rehydration injection)
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("Hello");
  });

  it("does not mutate input messages", () => {
    const recent = [{ role: "user" as const, content: "Original" }];
    const compacted = { summary: "Sum", recentMessages: recent };

    const result = buildRehydratedHistory(compacted, {}, []);
    // Mutating result should not affect input
    result[result.length - 1].content = "Modified";
    expect(recent[0].content).toBe("Original");
  });
});
