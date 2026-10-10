import { describe, expect, it } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
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
  it("executes world-init tools, records calls, then commits schema and protected dimension records without duplicate lorebook rows", async () => {
    const store = createMemoryStore();
    await store.createSession({
      locale: "en-US",
      id: context.sessionId,
      status: "active",
      phase: "setup",
      completedPlayerTurns: 0,
      setupRuntimes: {},
      activePlugins: ["world-init"],
      metadata: { _dimensionProviderPluginId: "world-init" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
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
          definitions: {
            reputation: {
              name: "Reputation",
              schema: { type: "integer" },
              initialValue: 0,
            },
          },
        }),
      },
      context,
    );

    expect(initializeResult.success).toBe(true);
    expect(initializeResult.pendingProposals).toHaveLength(2);

    const calls = await store.listToolCalls(context.sessionId);
    expect(calls.map((call) => call.toolName)).toEqual(["initialize-world"]);
    expect(calls.every((call) => call.approvalStatus === "auto-allowed")).toBe(
      true,
    );

    const proposals = initializeResult.pendingProposals ?? [];
    const commitResults =
      await createCommitPipeline(store).commitAll(proposals);
    expect(commitResults.every((result) => result.committed)).toBe(true);

    const schema = await store.getCharacterSchema(context.sessionId);
    expect(schema).toMatchObject({ version: 1 });
    expect(schema?.attributes).toHaveLength(15);
    expect(schema?.attributes.slice(0, 2)).toEqual([
      expect.objectContaining({ id: "field1", category: "stats" }),
      expect.objectContaining({ id: "field2", category: "bio" }),
    ]);

    const dimensions = await store.listPluginData(
      context.sessionId,
      context.pluginId,
      "_dimensions",
    );
    expect(dimensions).toMatchObject([
      { key: "reputation", value: { value: 0, version: 1 } },
    ]);
    expect(await store.listSessionLorebookEntries(context.sessionId)).toEqual(
      [],
    );
  });
});
