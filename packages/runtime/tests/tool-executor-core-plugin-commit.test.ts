import { describe, expect, it } from "vitest";
import { createMemoryStore } from "@covel/store";
import { tool, z } from "@covel/tools";
import { createToolExecutor } from "../src/agent-loop/tool-executor.js";
import { createCommitPipeline } from "../src/session/session-kernel.js";
import setWorldSchema from "../../../plugins/world-init/tools/set-world-schema.js";
import setWorldEntriesBatch from "../../../plugins/world-init/tools/set-world-entries-batch.js";

const context = {
  sessionId: "sess-tool-core",
  turnId: "turn-tool-core",
  pluginId: "world-init",
  runtimeId: "world-init/schema-gen",
};

describe("ToolExecutor + core plugin pending proposals + commit pipeline", () => {
  it("executes world-init tools, records calls, then commits schema, entries and lorebook rows", async () => {
    const store = createMemoryStore();
    const schemaTool = setWorldSchema({ tool, z, store });
    const entriesTool = setWorldEntriesBatch({ tool, z, store });
    const toolMap = new Map([
      [schemaTool.name, schemaTool],
      [entriesTool.name, entriesTool],
    ]);
    const executor = createToolExecutor({
      findTool: (name) => toolMap.get(name),
      getToolSource: () => "local",
      store,
    });

    const schemaResult = await executor.execute(
      {
        toolCallId: "call-schema",
        name: "set-world-schema",
        arguments: JSON.stringify({
          attributes: [
            {
              id: "hp",
              name: "生命值",
              type: "number",
              min: 0,
              max: 100,
              defaultValue: 100,
              category: "stats",
            },
            {
              id: "sect",
              name: "宗门",
              type: "string",
              category: "social",
            },
          ],
        }),
      },
      context,
    );
    const entriesResult = await executor.execute(
      {
        toolCallId: "call-entries",
        name: "set-world-entries-batch",
        arguments: JSON.stringify({
          entries: [
            { key: "geography", value: { regions: ["云梦泽"] } },
            { key: "factions", value: { groups: ["青萍宗"] } },
          ],
        }),
      },
      context,
    );

    expect(schemaResult.success).toBe(true);
    expect(entriesResult.success).toBe(true);
    expect(schemaResult.pendingProposals).toHaveLength(1);
    expect(entriesResult.pendingProposals).toHaveLength(2);

    const calls = await store.listToolCalls(context.sessionId);
    expect(calls.map((call) => call.toolName)).toEqual([
      "set-world-schema",
      "set-world-entries-batch",
    ]);
    expect(calls.every((call) => call.approvalStatus === "auto-allowed")).toBe(
      true,
    );

    const proposals = [
      ...(schemaResult.pendingProposals ?? []),
      ...(entriesResult.pendingProposals ?? []),
    ];
    const commitResults =
      await createCommitPipeline(store).commitAll(proposals);
    expect(commitResults.every((result) => result.committed)).toBe(true);

    const schema = await store.getPluginData(
      context.sessionId,
      context.pluginId,
      "schema",
      "character-attributes",
    );
    expect(schema?.value).toMatchObject({
      version: 1,
      attributes: [
        expect.objectContaining({ id: "hp", type: "number" }),
        expect.objectContaining({ id: "sect", type: "string" }),
      ],
    });

    const entries = await store.listPluginData(
      context.sessionId,
      context.pluginId,
      "entries",
    );
    expect(entries.map((entry) => entry.key).sort()).toEqual([
      "factions",
      "geography",
    ]);

    const lorebook = await store.listSessionLorebookEntries(context.sessionId);
    expect(lorebook.map((entry) => entry.id)).toEqual([
      "world-entry:geography",
      "world-entry:factions",
    ]);
    expect(lorebook[0]).toMatchObject({
      pluginId: "world-init",
      keys: ["geography"],
      strategy: "constant",
      insertionOrder: 100,
    });
  });
});
