import { describe, expect, it, vi } from "vitest";
import { createMemoryTools } from "../src/index.js";

describe("kernel memory search", () => {
  it("searches recall and archival within the bound session and merges ranked results", async () => {
    const recall = vi.fn(async () => [
      {
        turnId: "t",
        role: "user",
        content: "compass",
        score: 1,
        timestamp: "today",
      },
    ]);
    const archival = vi.fn(async () => [
      {
        key: "captain",
        content: "sapphire compass",
        source: "character",
        score: 2,
      },
    ]);
    const tools = createMemoryTools({
      recall: { search: recall },
      archival: { search: archival },
    });
    expect(tools.map((tool) => tool.name)).toEqual(["memory-search"]);
    const result = await tools[0]!.execute(
      { query: "compass", limit: 1 },
      { sessionId: "s", turnId: "t", pluginId: "p", runtimeId: "p/r" },
    );
    expect(recall).toHaveBeenCalledWith("s", "compass", 1);
    expect(archival).toHaveBeenCalledWith("s", "compass", 1);
    expect(result).toMatchObject({
      resultCount: 1,
      results: [{ source: "archival:character", key: "captain" }],
    });
  });
});
