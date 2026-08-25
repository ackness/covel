import { describe, expect, it, vi } from "vitest";
import { createMemoryTools, getPendingProposals } from "../src/index.js";
import type { ToolExecutionContext, ToolModule } from "../src/types.js";

function findTool(tools: readonly ToolModule[], name: string): ToolModule {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Tool not found: ${name}`);
  return found;
}

const context: ToolExecutionContext = {
  sessionId: "session-custom-memory",
  turnId: "turn-custom-memory",
  pluginId: "custom-memory-plugin",
  runtimeId: "custom-memory-plugin/runtime",
};

describe("memory block tools", () => {
  it("accepts a world-defined custom block label for reads and writes", async () => {
    const getBlock = vi.fn(async (_sessionId: string, label: string) => ({
      label,
      content: "weathered map notes",
      updatedAt: "2026-08-25T00:00:00.000Z",
    }));
    const tools = createMemoryTools({
      recall: { search: async () => [] },
      archival: { search: async () => [] },
      blocks: { getBlock },
    });
    const read = findTool(tools, "memory-get-block");
    const update = findTool(tools, "memory-update-block");

    const readResult = await read.execute({ label: "quest_threads" }, context);
    const updateResult = await update.execute(
      { label: "quest_threads", content: "follow the northern road" },
      context,
    );

    expect(readResult).toMatchObject({
      found: true,
      label: "quest_threads",
      content: "weathered map notes",
    });
    expect(getBlock).toHaveBeenCalledWith(
      "session-custom-memory",
      "quest_threads",
    );
    expect(getPendingProposals(updateResult)[0]).toMatchObject({
      type: "working_memory.set",
      payload: {
        scope: "story",
        key: "quest_threads",
        value: { text: "follow the northern road" },
      },
    });
  });
});
