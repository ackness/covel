import { describe, expect, it } from "vitest";
import { createMemoryStore } from "@covel/store";
import { tool, z } from "@covel/tools";
import { createToolExecutor } from "../src/agent-loop/tool-executor.js";
import { createCommitPipeline } from "../src/session/session-kernel.js";
import initializeWorld from "../../../plugins/world-init/tools/initialize-world.js";

const context = {
  sessionId: "sess-tool-core",
  turnId: "turn-tool-core",
  pluginId: "world-init",
  runtimeId: "world-init/schema-gen",
};

const categories = ["stats", "bio", "abilities", "equipment", "social"];

function makeAttributes() {
  return Array.from({ length: 15 }, (_, index) => ({
    id: `field${index + 1}`,
    name: `字段 ${index + 1}`,
    type: "string",
    category: categories[index % categories.length],
  }));
}

describe("ToolExecutor + core plugin pending proposals + commit pipeline", () => {
  it("executes world-init tools, records calls, then commits schema, entries and lorebook rows", async () => {
    const store = createMemoryStore();
    const initializeTool = initializeWorld({ tool, z, store });
    const toolMap = new Map([[initializeTool.name, initializeTool]]);
    const executor = createToolExecutor({
      findTool: (name) => toolMap.get(name),
      getToolSource: () => "local",
      store,
    });

    const initializeResult = await executor.execute(
      {
        toolCallId: "call-initialize",
        name: "initialize-world",
        arguments: JSON.stringify({
          attributes: makeAttributes(),
          entries: [
            { key: "geography", value: { regions: ["云梦泽"] } },
            { key: "factions", value: { groups: ["青萍宗"] } },
            { key: "power-system", value: { name: "灵脉" } },
            { key: "social-structure", value: { ranks: ["外门", "内门"] } },
            { key: "currency", value: { name: "灵石" } },
          ],
        }),
      },
      context,
    );

    expect(initializeResult.success).toBe(true);
    expect(initializeResult.pendingProposals).toHaveLength(3);

    const calls = await store.listToolCalls(context.sessionId);
    expect(calls.map((call) => call.toolName)).toEqual(["initialize-world"]);
    expect(calls.every((call) => call.approvalStatus === "auto-allowed")).toBe(
      true,
    );

    const proposals = initializeResult.pendingProposals ?? [];
    const commitResults =
      await createCommitPipeline(store).commitAll(proposals);
    expect(commitResults.every((result) => result.committed)).toBe(true);

    const schema = await store.getPluginData(
      context.sessionId,
      context.pluginId,
      "schema",
      "character-attributes",
    );
    expect(schema?.value).toMatchObject({ version: 1 });
    expect(schema?.value.attributes).toHaveLength(15);
    expect(schema?.value.attributes.slice(0, 2)).toEqual([
      expect.objectContaining({ id: "field1", category: "stats" }),
      expect.objectContaining({ id: "field2", category: "bio" }),
    ]);

    const entries = await store.listPluginData(
      context.sessionId,
      context.pluginId,
      "entries",
    );
    expect(entries.map((entry) => entry.key).sort()).toEqual([
      "currency",
      "factions",
      "geography",
      "power-system",
      "social-structure",
    ]);

    const lorebook = await store.listSessionLorebookEntries(context.sessionId);
    expect(lorebook.map((entry) => entry.id)).toEqual([
      "world-entry:geography",
      "world-entry:factions",
      "world-entry:power-system",
      "world-entry:social-structure",
      "world-entry:currency",
    ]);
    expect(lorebook[0]).toMatchObject({
      pluginId: "world-init",
      keys: ["geography"],
      strategy: "constant",
      insertionOrder: 100,
    });
  });
});
