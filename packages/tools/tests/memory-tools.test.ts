import { describe, expect, it, vi } from "vitest";
import type { Proposal } from "@covel/shared";
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
  it.each([false, true])(
    "reads the latest pending update before commit (stored block: %s)",
    async (stored) => {
      const getBlock = vi.fn(async () =>
        stored
          ? { label: "quest_threads", content: "old", updatedAt: "old-time" }
          : null,
      );
      const tools = createMemoryTools({
        recall: { search: async () => [] },
        archival: { search: async () => [] },
        blocks: { getBlock },
      });
      const update = findTool(tools, "memory-update-block");
      const first = await update.execute(
        { label: "quest_threads", content: "first" },
        context,
      );
      const last = await update.execute(
        { label: "quest_threads", content: "latest" },
        { ...context, pluginId: "another-plugin" },
      );
      const pending = [
        ...getPendingProposals(first),
        ...getPendingProposals(last),
      ];
      expect(
        await findTool(tools, "memory-get-block").execute(
          { label: "quest_threads" },
          { ...context, pendingProposals: pending },
        ),
      ).toMatchObject({
        found: true,
        label: "quest_threads",
        content: "latest",
        updatedAt: pending.at(-1)?.timestamp,
      });
      expect(getBlock).not.toHaveBeenCalled();
    },
  );

  it("ignores pending memory from another session, scope or label", async () => {
    const getBlock = vi.fn(async () => ({
      label: "quest_threads",
      content: "stored",
      updatedAt: "stored-time",
    }));
    const tools = createMemoryTools({
      recall: { search: async () => [] },
      archival: { search: async () => [] },
      blocks: { getBlock },
    });
    const proposal: Proposal = {
      id: "pending-memory",
      type: "working_memory.set",
      source: { pluginId: context.pluginId, runtimeId: context.runtimeId },
      sessionId: context.sessionId,
      turnId: context.turnId,
      timestamp: "2026-08-25T00:00:00.000Z",
      payload: {
        scope: "story",
        key: "quest_threads",
        value: { text: "pending" },
      },
    };
    expect(
      await findTool(tools, "memory-get-block").execute(
        { label: "quest_threads" },
        {
          ...context,
          pendingProposals: [
            { ...proposal, sessionId: "other-session" },
            { ...proposal, payload: { ...proposal.payload, scope: "player" } },
            {
              ...proposal,
              payload: { ...proposal.payload, key: "other-label" },
            },
          ],
        },
      ),
    ).toMatchObject({
      found: true,
      content: "stored",
      updatedAt: "stored-time",
    });
    expect(getBlock).toHaveBeenCalledWith(context.sessionId, "quest_threads");
  });

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
