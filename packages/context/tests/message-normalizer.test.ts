import { describe, it, expect } from "vitest";
import { normalizeMessages } from "../src/normalizer/message-normalizer.js";

describe("normalizeMessages", () => {
  // ── Rule 1: Empty message filtering ─────────────────────────────

  it("removes messages with empty content", () => {
    const { messages, repairs } = normalizeMessages([
      { role: "system", content: "You are helpful." },
      { role: "user", content: "" },
      { role: "user", content: "Hello" },
    ]);

    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe("You are helpful.");
    expect(messages[1].content).toBe("Hello");
    expect(repairs).toHaveLength(1);
    expect(repairs[0].action).toBe("removed");
  });

  it("removes messages with whitespace-only content", () => {
    const { messages } = normalizeMessages([
      { role: "user", content: "   " },
      { role: "user", content: "Hi" },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("Hi");
  });

  // ── Rule 2: Consecutive same-role merging ───────────────────────

  it("merges consecutive messages with same role", () => {
    const { messages, repairs } = normalizeMessages([
      { role: "user", content: "Part 1" },
      { role: "user", content: "Part 2" },
      { role: "assistant", content: "Reply" },
    ]);

    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe("Part 1\n\nPart 2");
    expect(messages[1].content).toBe("Reply");
    expect(repairs.some((r) => r.action === "merged")).toBe(true);
  });

  it("does not merge non-consecutive same-role messages", () => {
    const { messages } = normalizeMessages([
      { role: "user", content: "Q1" },
      { role: "assistant", content: "A1" },
      { role: "user", content: "Q2" },
    ]);

    expect(messages).toHaveLength(3);
  });

  // ── Rule 3: Valid start ─────────────────────────────────────────

  it("reorders when sequence starts with assistant", () => {
    const { messages, repairs } = normalizeMessages([
      { role: "assistant", content: "Hello" },
      { role: "user", content: "Hi" },
    ]);

    expect(messages[0].role).toBe("user");
    expect(repairs.some((r) => r.action === "reordered")).toBe(true);
  });

  it("prepends user message when all messages are assistant", () => {
    const { messages, repairs } = normalizeMessages([
      { role: "assistant", content: "Text 1" },
      { role: "assistant", content: "Text 2" },
    ]);

    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("Continue.");
    expect(repairs.some((r) => r.action === "reordered")).toBe(true);
  });

  it("does not modify when starting with system", () => {
    const { messages, repairs } = normalizeMessages([
      { role: "system", content: "System prompt" },
      { role: "user", content: "Hello" },
    ]);

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    // Filter out repairs that are not about reordering
    expect(repairs.filter((r) => r.action === "reordered")).toHaveLength(0);
  });

  // ── Rule 4: Trailing system messages ────────────────────────────

  it("converts trailing system message to user", () => {
    const { messages, repairs } = normalizeMessages([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
      { role: "system", content: "Reminder" },
    ]);

    expect(messages[messages.length - 1].role).toBe("user");
    expect(messages[messages.length - 1].content).toBe("Reminder");
    expect(repairs.some((r) => r.action === "repaired")).toBe(true);
  });

  it("does not convert if only one system message", () => {
    const { messages } = normalizeMessages([
      { role: "system", content: "Only message" },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("system");
  });

  // ── Rule 5: Anthropic constraints ───────────────────────────────

  it("converts non-leading system messages to user for Anthropic", () => {
    const { messages, repairs } = normalizeMessages(
      [
        { role: "system", content: "System prompt" },
        { role: "user", content: "Hello" },
        { role: "system", content: "Another system" },
        { role: "assistant", content: "Reply" },
      ],
      { provider: "anthropic" }
    );

    expect(messages[0].role).toBe("system");
    expect(messages[2].role).toBe("user");
    expect(messages[2].content).toBe("Another system");
    expect(repairs.some((r) => r.reason.includes("Anthropic"))).toBe(true);
  });

  it("preserves leading system messages for Anthropic", () => {
    const { messages } = normalizeMessages(
      [
        { role: "system", content: "SP1" },
        { role: "system", content: "SP2" },
        { role: "user", content: "Hello" },
      ],
      { provider: "anthropic" }
    );

    // After merging consecutive system messages, there's one system message
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("SP1");
    expect(messages[0].content).toContain("SP2");
  });

  // ── Edge cases ──────────────────────────────────────────────────

  it("handles empty input", () => {
    const { messages, repairs } = normalizeMessages([]);
    expect(messages).toHaveLength(0);
    expect(repairs).toHaveLength(0);
  });

  it("handles single valid message", () => {
    const { messages } = normalizeMessages([
      { role: "user", content: "Hello" },
    ]);
    expect(messages).toHaveLength(1);
  });

  it("does not mutate original messages", () => {
    const original = [
      { role: "user", content: "A" },
      { role: "user", content: "B" },
    ];
    const contentBefore = original.map((m) => m.content);

    normalizeMessages(original);

    expect(original.map((m) => m.content)).toEqual(contentBefore);
    expect(original).toHaveLength(2);
  });

  it("applies all rules in complex scenario", () => {
    const { messages } = normalizeMessages(
      [
        { role: "assistant", content: "Orphan" },
        { role: "system", content: "System" },
        { role: "user", content: "" },
        { role: "user", content: "Q1" },
        { role: "user", content: "Q2" },
        { role: "assistant", content: "A1" },
        { role: "system", content: "Reminder" },
      ],
      { provider: "anthropic" }
    );

    // Should produce a valid Anthropic message sequence
    expect(messages[0].role).toBe("system");
    // No empty messages
    expect(messages.every((m) => m.content.trim() !== "")).toBe(true);
    // No consecutive same-role (except possibly after reordering)
    for (let i = 1; i < messages.length; i++) {
      if (messages[i].role === messages[i - 1].role) {
        // This should not happen after merging
        expect(true).toBe(false);
      }
    }
  });
});
