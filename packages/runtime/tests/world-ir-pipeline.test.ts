import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  LLMAdapter,
  LLMResponse,
  RuntimeManifest,
  TurnInput,
} from "@covel/shared";
import { WORLD_IR_V1_JSON_SCHEMA as worldIrSchema } from "@covel/shared";
import {
  discoverPlugins,
  loadPluginManifest,
  loadRuntime,
  type LoadedRuntime,
  type PluginDiscoveryResult,
} from "@covel/plugin-loader";
import { createMemoryStore } from "@covel/store";
import { executeTurn } from "../src/turn-executor/turn-executor.js";

const PLUGINS_DIR = path.resolve(import.meta.dirname, "../../../plugins");

const VALID_WORLD_IR = {
  schemaVersion: 1,
  summary: "The player found a brass key in the observatory.",
  entities: [
    { id: "observatory", type: "location", name: "Observatory" },
    { id: "brass-key", type: "item", name: "Brass Key" },
  ],
  relations: [],
  events: [
    {
      id: "found-brass-key",
      type: "inventory_change",
      participantIds: ["brass-key"],
      attributes: { operation: "acquire", quantity: 1 },
    },
  ],
  statements: [],
} as const;

class PipelineLLM implements LLMAdapter {
  readonly calls: Array<Parameters<LLMAdapter["generate"]>[0]> = [];

  constructor(private readonly worldIrContent: string) {}

  async generate(
    params: Parameters<LLMAdapter["generate"]>[0],
  ): Promise<LLMResponse> {
    this.calls.push(params);
    return {
      content:
        params.model === "story"
          ? "You find a brass key beneath the observatory desk."
          : this.worldIrContent,
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  }
}

async function createMainLoopStore() {
  const store = createMemoryStore();
  await store.appendTurnMessage({
    id: "prior-player",
    sessionId: "session-world-ir",
    turnId: "prior-turn",
    sourceType: "player",
    role: "user",
    content: "prior",
    order: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  return store;
}

async function discoverRuntime(pluginId: string): Promise<{
  readonly discovery: PluginDiscoveryResult;
  readonly manifest: RuntimeManifest;
}> {
  const discoveries = await discoverPlugins(PLUGINS_DIR);
  const discovery = discoveries.find((candidate) => candidate.id === pluginId);
  if (!discovery) throw new Error(`missing plugin discovery: ${pluginId}`);
  const manifests = await loadPluginManifest(discovery);
  const parsed = manifests.find(
    (candidate) => candidate.manifest.name === pluginId,
  );
  if (!parsed) throw new Error(`missing runtime manifest: ${pluginId}`);
  return { discovery, manifest: parsed.manifest };
}

async function runPipeline(worldIrContent: string) {
  const narrator = await discoverRuntime("narrator");
  const worldIr = await discoverRuntime("world-ir");
  const observedInputs: unknown[] = [];
  const consumer: RuntimeManifest = {
    name: "test-world-ir-consumer",
    pluginId: "test-world-ir-consumer",
    description: "Captures the shared typed WorldIR slot.",
    pluginType: "plugin",
    stage: "post-turn",
    runtimeType: "function",
    handler: "./unused.js",
    outputKind: "system",
    trigger: { type: "auto" },
    inputs: {
      worldIR: {
        from: { capability: "world-ir-provider", cardinality: "one" },
        accepts: "covel://world/ir/v1",
        required: true,
      },
    },
  };
  const llm = new PipelineLLM(worldIrContent);
  const loadedByName = new Map<string, Promise<LoadedRuntime>>([
    [
      narrator.manifest.name,
      loadRuntime(narrator.discovery, narrator.manifest.name),
    ],
    [
      worldIr.manifest.name,
      loadRuntime(worldIr.discovery, worldIr.manifest.name),
    ],
    [
      consumer.name,
      Promise.resolve({
        manifest: consumer,
        promptTemplate: "",
        bindingAcceptsSchemas: {
          worldIR: worldIrSchema,
        },
        handler: async (ctx) => {
          observedInputs.push(ctx.inputs);
          return { outcome: "success", value: { consumed: true } };
        },
      }),
    ],
  ]);
  const input: TurnInput = {
    sessionId: "session-world-ir",
    turnId: "turn-world-ir",
    playerMessage: "Search the desk.",
  };

  const result = await executeTurn(
    input,
    [narrator.manifest, worldIr.manifest, consumer],
    {
      llm,
      store: await createMainLoopStore(),
      loadRuntime: async (manifest) => {
        const loaded = loadedByName.get(manifest.name);
        if (!loaded)
          throw new Error(`missing loaded runtime: ${manifest.name}`);
        return loaded;
      },
    },
  );

  return { result, llm, observedInputs };
}

describe("shared WorldIR turn pipeline", () => {
  it("extracts once, validates it, and binds the same-turn value with provenance", async () => {
    const { result, llm, observedInputs } = await runPipeline(
      JSON.stringify(VALID_WORLD_IR),
    );
    const byRuntime = new Map(
      result.runtimeResults.map((runtimeResult) => [
        runtimeResult.runtimeId,
        runtimeResult,
      ]),
    );

    expect(byRuntime.get("narrator")?.status).toBe("success");
    expect(byRuntime.get("world-ir")?.status).toBe("success");
    expect(byRuntime.get("test-world-ir-consumer")?.status).toBe("success");
    expect(observedInputs).toEqual([
      {
        worldIR: {
          cardinality: "one",
          value: VALID_WORLD_IR,
          source: {
            pluginId: "world-ir",
            runtimeId: "world-ir",
            resultId: byRuntime.get("world-ir")?.runId,
          },
        },
      },
    ]);

    const extractorCall = llm.calls.find((call) => call.model === "plugin");
    expect(extractorCall?.responseFormat?.schema.$id).toBe(
      "covel://world/ir/v1",
    );
    expect(
      extractorCall?.messages.some(
        (message) =>
          typeof message.content === "string" &&
          message.content.includes(
            "You find a brass key beneath the observatory desk.",
          ),
      ),
    ).toBe(true);
  });

  it("keeps the story result but skips typed consumers when extraction fails", async () => {
    const invalid = {
      ...VALID_WORLD_IR,
      relations: [
        {
          id: "missing-reference",
          type: "LOCATED_IN",
          from: "brass-key",
          to: "missing-location",
        },
      ],
    };
    const { result, observedInputs } = await runPipeline(
      JSON.stringify(invalid),
    );
    const byRuntime = new Map(
      result.runtimeResults.map((runtimeResult) => [
        runtimeResult.runtimeId,
        runtimeResult,
      ]),
    );

    expect(byRuntime.get("narrator")?.status).toBe("success");
    expect(byRuntime.get("world-ir")?.status).toBe("failed");
    expect(byRuntime.get("world-ir")?.error).toContain("does not exist");
    expect(byRuntime.get("test-world-ir-consumer")?.status).toBe("skipped");
    expect(byRuntime.get("test-world-ir-consumer")?.output).toMatchObject({
      reason: "upstream-failed",
      skippedBy: "framework:inputBinding",
    });
    expect(observedInputs).toEqual([]);
  });
});
