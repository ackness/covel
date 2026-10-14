import { describe, expect, it, vi } from "vitest";
import { createMemoryTools } from "../src/index.js";

describe("kernel memory search", () => {
  it("delegates ranking and scope to memory and only formats tool output", async () => {
    const search = vi.fn(async () => [
      {
        source: "recall",
        role: "user",
        content: "compass",
        score: 0.2,
        timestamp: "today",
      },
      {
        source: "archival:character",
        key: "captain",
        content: "sapphire compass",
        score: 1,
      },
    ]);
    const [tool] = createMemoryTools({ search });
    const result = await tool!.execute(
      { query: "compass", limit: 2 },
      {
        sessionId: "s",
        turnId: "t",
        pluginId: "p",
        runtimeId: "p/r",
        random: { int: (min: number) => min },
      },
    );
    expect(search).toHaveBeenCalledExactlyOnceWith("s", "compass", {
      scope: "all",
      limit: 2,
    });
    expect(result).toMatchObject({
      resultCount: 2,
      results: [
        { source: "recall", content: "[user] compass", score: 0.2 },
        { source: "archival:character", key: "captain", score: 1 },
      ],
    });
  });
});

it("preserves memory excerpts and hides internal message identities", async () => {
  const excerpt = "x".repeat(490) + "compass…";
  const [tool] = createMemoryTools({
    search: async () => [
      {
        source: "recall",
        role: "assistant",
        content: excerpt,
        messageId: "private-message-id",
        score: 1,
      },
    ],
  });
  const result = await tool!.execute(
    { query: "compass" },
    {
      sessionId: "s",
      turnId: "t",
      pluginId: "p",
      runtimeId: "p/r",
      random: { int: (min: number) => min },
    },
  );
  expect(result).toMatchObject({
    results: [{ content: `[assistant] ${excerpt}` }],
  });
  expect(JSON.stringify(result)).not.toContain("private-message-id");
  expect(JSON.stringify(result)).not.toContain("messageId");
  expect(tool!.description).not.toContain("not meaning");
});
