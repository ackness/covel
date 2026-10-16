import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { LLMAdapter, RuntimeManifest } from "@covel/shared";
import { createMemoryStore } from "@covel/store/memory";
import { tool, z } from "@covel/tools";
import initializeWorld from "../../../plugins/world-init/tools/initialize-world.js";
import schemaGuard from "../../../plugins/world-init/guard.js";
import { createToolExecutor } from "../src/agent-loop/tool-executor.js";
import { finalizeExecution } from "../src/commit/finalize-execution.js";
import { runTurnPipeline } from "../src/turn-executor/turn-executor.js";

const outputSchema = JSON.parse(
  readFileSync(
    new URL(
      "../../../plugins/world-init/runtimes/schema-gen/output.schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const runtime: RuntimeManifest = {
  name: "world-init/schema-gen",
  pluginId: "world-init",
  description: "Generate a world's character schema",
  stage: "setup",
  runtimeType: "agent",
  outputKind: "system",
  guard: "../../guard.js",
  output: { schema: "./output.schema.json" },
  outputContract: "world-data-provider@1",
  tools: { plugin: ["initialize-world"] },
  requireToolUse: true,
  completeAfterTools: ["initialize-world"],
};
const categories = ["stats", "bio", "abilities", "equipment", "social"];
const attributes = Array.from({ length: 15 }, (_, index) => ({
  id: `field${index}`,
  name: `Field ${index}`,
  type: "string",
  category: categories[index % categories.length],
}));

describe("schema-gen completion and public output contract", () => {
  it.each([false, true])(
    "commits the schema and completes setup (authored schema: %s)",
    async (authored) => {
      const store = createMemoryStore();
      const now = new Date().toISOString();
      const worldSchema = {
        types: ["npc", "companion"],
        attributes: authored ? [] : attributes,
      };
      await store.upsertWorld({
        id: "world",
        name: "Small world",
        description: "A quiet harbor",
        lore: "A quiet harbor",
        ...(authored ? { metadata: { characterSchema: worldSchema } } : {}),
        createdAt: now,
        updatedAt: now,
      });
      await store.createSession({
        id: "session",
        worldId: "world",
        locale: "en-US",
        status: "active",
        phase: "setup",
        completedPlayerTurns: 0,
        setupRuntimes: {},
        activePlugins: ["world-init"],
        metadata: { _dimensionProviderPluginId: "world-init" },
        createdAt: now,
        updatedAt: now,
      });
      const initialize = initializeWorld({ tool, z });
      const generate = vi.fn<LLMAdapter["generate"]>(async () => ({
        content: "",
        toolCalls: [
          {
            id: "initialize",
            name: "initialize-world",
            arguments: JSON.stringify({ attributes }),
          },
        ],
        finishReason: "tool_calls",
        usage: { inputTokens: 1, outputTokens: 1 },
      }));
      const turn = await runTurnPipeline(
        {
          sessionId: "session",
          turnId: "setup",
          origin: "player",
          playerMessage: "Start",
        },
        [runtime],
        {
          store,
          llm: { generate },
          getPluginSource: () => "builtin",
          toolExecutor: createToolExecutor({
            findTool: (name) =>
              name === "initialize-world" ? initialize : undefined,
            store,
          }),
          loadRuntime: async () => ({
            manifest: runtime,
            promptTemplate: "Call initialize-world once.",
            guard: schemaGuard,
            outputSchema,
            outputContractSchema: outputSchema,
          }),
        },
      );
      const result = turn.runtimeResults[0];
      expect(result?.error).toBeUndefined();
      expect(result?.status).toBe(authored ? "skipped" : "success");
      expect(result?.output).toMatchObject({
        success: true,
        attributeCount: worldSchema.attributes.length,
        dimensionCount: 0,
        worldSchema,
      });
      expect(generate).toHaveBeenCalledTimes(authored ? 0 : 1);
      expect(Object.keys(turn.setupCompletion?.newlyDone ?? {})).toEqual([
        runtime.name,
      ]);
      expect(turn.setupCompletion?.allSetupDone).toBe(true);
      if (!authored) {
        expect(result?.completion).toBe("done");
        expect(result?.toolCalls[0]?.output).toMatchObject({
          preGameDone: true,
        });
        expect(result?.output).not.toHaveProperty("preGameDone");
      }
      expect(await store.getCharacterSchema("session")).toBeNull();
      const committed = await finalizeExecution({
        store,
        sessionId: "session",
        executionContext: turn.executionContext,
        runtimes: [runtime],
        results: turn.runtimeResults,
        turnIds: [turn.turnId],
      });
      expect(committed.status).toBe("committed");
      expect(await store.getCharacterSchema("session")).toMatchObject(
        worldSchema,
      );
    },
  );
});
