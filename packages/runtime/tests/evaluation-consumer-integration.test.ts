import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  discoverPlugins,
  loadPluginManifest,
  loadRuntime,
} from "@covel/plugin-loader";
import { createMemoryStore } from "@covel/store";
import {
  tool,
  shortId,
  shortIdBatch,
  withPendingProposals,
  type ToolModule,
} from "@covel/tools";
import type { RuntimeManifest } from "@covel/shared";
import type {
  PluginRuntimeGateway,
  LoadedRuntime,
} from "@covel/shared/plugin-runtime";
import { PluginServiceRegistry } from "../src/plugin-services.js";
import { executeTurn } from "../src/turn-executor/turn-executor.js";
import { createToolExecutor } from "../src/agent-loop/tool-executor.js";
import { processRuntimeResult } from "../src/session/session-kernel.js";

const root = path.resolve(import.meta.dirname, "../../../plugins");
describe("plugin-owned evaluation integration", () => {
  it("passes real scene-prompts tool output into a synthetic consumer, calls its service, and commits its own data", async () => {
    const discoveries = [
      ...(await discoverPlugins(root)),
      ...(await discoverPlugins(
        path.join(import.meta.dirname, "test-plugins"),
      )),
    ];
    const loaded = new Map<string, LoadedRuntime>();
    const services = new PluginServiceRegistry({
      list: async () => ["evaluation-consumer"],
      ensure: async () => {},
    });
    const tools = new Map<string, ToolModule>();
    for (const id of ["scene-prompts", "evaluation-consumer"]) {
      const discovery = discoveries.find((d) => d.id === id)!;
      const [parsed] = await loadPluginManifest(discovery);
      const runtime = await loadRuntime(discovery, parsed!.manifest.name);
      loaded.set(runtime.manifest.name, runtime);
      const entry = await import(
        pathToFileURL(path.join(discovery.rootPath, parsed!.manifest.entry!))
          .href
      );
      entry.default({
        toolkit: { tool, z, shortId, shortIdBatch, withPendingProposals },
        registerTool: (value: ToolModule) => tools.set(value.name, value),
        registerService: (
          definition: Parameters<typeof services.register>[1],
        ) => services.register(id, definition),
      });
    }
    const narrator: RuntimeManifest = {
      name: "test-narrator",
      pluginId: "test-narrator",
      description: "Narrative fixture",
      stage: "narrative",
      runtimeType: "function",
      outputKind: "story",
      capabilities: ["narrative-engine"],
      trigger: { type: "auto" },
    };
    loaded.set(narrator.name, {
      manifest: narrator,
      promptTemplate: "",
      outputSchema: {
        type: "object",
        properties: { narrativeOutput: { type: "string" } },
        required: ["narrativeOutput"],
      },
      handler: async () => ({
        outcome: "success",
        value: { narrativeOutput: "A friend offers a tour of the school." },
      }),
    });
    const candidate = {
      scene: "School tour",
      recap:
        "A friend has offered a tour and you are deciding what to visit next.",
      decision: "Where would you like to go next?",
      prompts: [
        { kind: "ask", text: "Ask about the library" },
        { kind: "act", text: "Explore the classroom" },
        { kind: "observe", text: "Look at the map" },
      ],
    };
    const evaluate = vi.fn(async () => ({
      model: "fixture/evaluation",
      provider: "fixture",
      answers: {
        recommendation: {
          type: "choice",
          choice: "prompt:2",
          probabilities: { "prompt:1": 0.2, "prompt:2": 0.6, "prompt:3": 0.2 },
        },
      },
      usage: { inputTokens: 50, outputTokens: 0 },
    }));
    const gateway = {
      evaluate,
      resolveSlot: () => ({ tag: "evaluation" }),
    } as unknown as PluginRuntimeGateway;
    const store = createMemoryStore();
    const result = await executeTurn(
      {
        sessionId: "demo-test",
        turnId: "turn-1",
        turnNumber: 1,
        playerMessage: "Show me the classroom",
      },
      [
        narrator,
        ...[...loaded.values()]
          .filter((r) => r.manifest.name !== narrator.name)
          .map((r) => r.manifest),
      ],
      {
        loadRuntime: async (manifest) => loaded.get(manifest.name),
        store,
        services,
        gateway,
        getPluginSource: () => "builtin",
        toolExecutor: createToolExecutor({
          findTool: (name) => tools.get(name),
          store,
        }),
        llm: {
          generate: async () => ({
            content: null,
            toolCalls: [
              {
                id: "call-1",
                name: "generate-scene-prompts",
                arguments: JSON.stringify(candidate),
              },
            ],
            finishReason: "tool_calls",
            usage: { inputTokens: 10, outputTokens: 5 },
          }),
        },
      },
    );
    const demo = result.runtimeResults.find(
      (r) => r.runtimeId === "evaluation-consumer",
    );
    expect(
      result.runtimeResults.map((r) => ({
        runtimeId: r.runtimeId,
        status: r.status,
        error: r.error,
        skipReason: r.skipReason,
      })),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runtimeId: "scene-prompts",
          status: "success",
        }),
        expect.objectContaining({
          runtimeId: "evaluation-consumer",
          status: "success",
        }),
      ]),
    );
    expect(evaluate).toHaveBeenCalledTimes(1);
    await processRuntimeResult(demo!, store, "demo-test", "system");
    const record = await store.getPluginData(
      "demo-test",
      "evaluation-consumer",
      "recommendations",
      "current",
    );
    expect(record?.value).toMatchObject({
      turnId: "turn-1",
      status: "ready",
      selectedId: "prompt:2",
      source: { pluginId: "scene-prompts" },
      options: [
        { probability: 0.2 },
        { probability: 0.6 },
        { probability: 0.2 },
      ],
    });
  });
});
