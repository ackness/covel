import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createCharacterTools,
  getPendingProposals,
  runtimeDoneTool,
} from "@covel/tools";
import { createMemoryStore } from "../../../packages/store/src/index.js";
import {
  createToolExecutor,
  executeTurn,
  finalizeExecution,
} from "../../../packages/runtime/src/index.js";
import { MockLLM } from "../../../packages/plugin-test-utils/src/mock-llm.js";
import { loadRuntimeBundle } from "../../../packages/test-runtime/src/runtime-loading.js";

const sessionId = "tracker-test-session";
const runtimeId = "char-creator/character-tracker";
const characterId = "tracker-test-character";
const now = "2026-09-05T00:00:00Z";

function response(name, args) {
  return {
    content: null,
    toolCalls: [{ id: name, name, arguments: JSON.stringify(args) }],
    finishReason: "tool_calls",
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

async function run(secondResponse) {
  const store = createMemoryStore();
  await store.createSession({
    id: sessionId,
    status: "active",
    phase: "playing",
    completedPlayerTurns: 0,
    setupRuntimes: {},
    activePlugins: ["char-creator"],
    createdAt: now,
    updatedAt: now,
  });
  await store.upsertCharacter({
    id: characterId,
    sessionId,
    name: "Mira",
    type: "npc",
    description: "A synthetic test character.",
    fields: { systems: 2 },
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  await store.setPluginData({
    sessionId,
    pluginId: "schema-source",
    namespace: "schema",
    key: "character-attributes",
    value: {
      version: 1,
      attributes: [
        {
          id: "systems",
          name: "Systems",
          type: "number",
          category: "abilities",
          min: 0,
          max: 5,
          defaultValue: 2,
        },
      ],
    },
    updatedAt: now,
  });
  // Reuse the CLI harness's real manifest/prompt loader, with a seeded
  // upstream result so the isolated tracker needs no narrative model call.
  const { target, loadedCache } = await loadRuntimeBundle({
    pluginsDir: path.resolve(import.meta.dirname, "../.."),
    pluginId: "char-creator",
    runtimeId,
    locale: "zh-CN",
    ignoreUpstreams: true,
    store,
  });
  const llm = new MockLLM({
    responses: [response("get-character", { id: characterId }), secondResponse],
  });
  const tools = new Map(
    [
      ...createCharacterTools(store, {
        findWorldDataPluginId: () => "schema-source",
      }),
      runtimeDoneTool,
    ].map((tool) => [tool.name, tool]),
  );
  const toolResults = [];
  const executor = createToolExecutor({
    store,
    findTool: (name) => tools.get(name),
  });
  const result = await executeTurn(
    {
      sessionId,
      turnId: "tracker-test-turn",
      playerMessage: "Inspect the recorded character changes.",
      origin: "manual",
      manualTrigger: {
        runtimeId,
        retrySeedResults: [
          {
            runtimeId: "narrator",
            pluginId: "narrator",
            runId: "narrator-test-run",
            turnId: "prior-test-turn",
            status: "success",
            output: { narrativeOutput: "Mira improves her systems skill." },
            toolCalls: [],
            durationMs: 1,
            timestamp: now,
          },
        ],
      },
    },
    [target],
    {
      store,
      llm,
      loadRuntime: async (manifest) => loadedCache.get(manifest.name),
      toolExecutor: {
        ...executor,
        async execute(call, context) {
          const result = await executor.execute(call, context);
          toolResults.push(result);
          return result;
        },
      },
    },
  );
  await finalizeExecution({
    store,
    sessionId,
    runtimes: [target],
    results: result.runtimeResults,
    turnIds: ["tracker-test-turn"],
    executionContext: {
      executionId: "tracker-test-turn",
      origin: "manual",
      countPolicy: "none",
    },
  });
  const tracker = result.runtimeResults.find(
    (item) => item.runtimeId === runtimeId,
  );
  expect(llm.calls).toHaveLength(2);
  expect(llm.calls[0].toolNames).toContain("get-character");
  expect(toolResults[0]).toMatchObject({
    name: "get-character",
    success: true,
    parsedResult: { found: true },
  });
  return { store, tracker, toolResults };
}

describe("character tracker two-step runtime", () => {
  it("reads details then commits a validated update on the second step", async () => {
    const { store, tracker } = await run(
      response("sync-characters", {
        updates: [{ id: characterId, fields: { systems: 3 } }],
      }),
    );
    expect(tracker.status).toBe("success");
    expect(tracker.toolCalls.map((call) => call.toolName)).toEqual([
      "get-character",
      "sync-characters",
    ]);
    expect((await store.listCharacters(sessionId))[0].fields).toEqual({
      systems: 3,
    });
  });

  it("reads details then explicitly finishes without changes", async () => {
    const { store, tracker } = await run(
      response("runtime-done", { reason: "No confirmed changes." }),
    );
    expect(tracker.status).toBe("success");
    expect(getPendingProposals(tracker.output) ?? []).toEqual([]);
    expect((await store.listCharacters(sessionId))[0].version).toBe(1);
  });

  it("does not treat successful reads as completion", async () => {
    const { store, tracker } = await run(
      response("get-character", { id: characterId }),
    );
    expect(tracker.status).toBe("failed");
    expect(tracker.error).toContain("exhausted the tool loop after 2 steps");
    expect(getPendingProposals(tracker.output) ?? []).toEqual([]);
    expect((await store.listCharacters(sessionId))[0].version).toBe(1);
  });

  it.each(["self-taught", 6])(
    "rejects invalid numeric field %j after the detail read",
    async (systems) => {
      const { store, tracker, toolResults } = await run(
        response("sync-characters", {
          updates: [{ id: characterId, fields: { systems } }],
        }),
      );
      expect(tracker.status).toBe("failed");
      expect(toolResults[1]).toMatchObject({
        name: "sync-characters",
        success: false,
      });
      expect(toolResults[1].result).toContain("systems");
      expect(getPendingProposals(tracker.output) ?? []).toEqual([]);
      expect((await store.listCharacters(sessionId))[0].fields).toEqual({
        systems: 2,
      });
    },
  );
});
