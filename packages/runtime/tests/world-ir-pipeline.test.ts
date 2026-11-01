import reviewWorldFacts from "../../../plugins/world-ir/server/review-output.js";
import { createHookPipeline } from "../src/hooks/pipeline.js";
import { latestToolOutput, toolCall } from "./_helpers/agent-loop-fixture.js";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  LLMAdapter,
  LLMResponse,
  RuntimeManifest,
  TurnInput,
} from "@covel/shared";
import { WORLD_IR_V1_JSON_SCHEMA as worldIrSchema } from "../../../plugins/world-ir/schemas/world-ir.js";
import {
  discoverPlugins,
  loadPluginManifest,
  loadRuntime,
  type LoadedRuntime,
  type PluginDiscoveryResult,
} from "@covel/plugin-loader";
import { createMemoryStore } from "@covel/store/memory";
import { tool } from "@covel/tools";
import makeSubmitWorldFacts from "../../../plugins/world-ir/tools/submit-world-facts.js";
import { createToolExecutor } from "../src/agent-loop/tool-executor.js";
import { runTurnPipeline } from "../src/turn-executor/turn-executor.js";

const PLUGINS_DIR = path.resolve(import.meta.dirname, "../../../plugins");

const VALID_WORLD_IR = {
  schemaVersion: 1,
  summary: "The player found a brass key in the observatory.",
  entities: [
    { id: "observatory", type: "location", name: "Observatory" },
    { id: "brass-key", type: "item", name: "Brass Key" },
    { id: "player", type: "character", name: "Player" },
  ],
  relations: [],
  events: [
    {
      id: "found-brass-key",
      type: "inventory_change",
      participantIds: ["player", "brass-key"],
      attributes: {
        item: "brass-key",
        holder: "player",
        operation: "gain",
        quantity: 1,
      },
    },
  ],
  statements: [],
} as const;

class PipelineLLM implements LLMAdapter {
  readonly calls: Array<Parameters<LLMAdapter["generate"]>[0]> = [];

  constructor(
    private readonly worldIrContent: string,
    private tamper = false,
  ) {}

  async generate(
    params: Parameters<LLMAdapter["generate"]>[0],
  ): Promise<LLMResponse> {
    this.calls.push(params);
    if (params.model !== "story") {
      const view = latestToolOutput(params.messages, "submit-world-facts");
      const canonical = view?.facts as Record<string, unknown> | undefined;
      if (canonical) {
        const output = this.tamper
          ? { ...canonical, summary: "Invented story facts." }
          : canonical;
        this.tamper = false;
        return toolCall("submit-output", output);
      }
      return {
        content: null,
        toolCalls: [
          {
            id: `submit-${this.calls.length}`,
            name: "submit-world-facts",
            arguments: this.worldIrContent,
          },
        ],
        finishReason: "tool_calls" as const,
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    }
    return {
      content: null,
      toolCalls: [
        {
          id: "final",
          name: "submit-output",
          arguments: JSON.stringify({
            segments: [
              {
                kind: "narration",
                text: "You find a brass key beneath the observatory desk.",
              },
            ],
          }),
        },
      ],
      finishReason: "tool_calls" as const,
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

async function runPipeline(worldIrContent: string, tamper = false) {
  const narrator = await discoverRuntime("narrator");
  const worldIr = await discoverRuntime("world-ir");
  const observedInputs: unknown[] = [];
  const consumer: RuntimeManifest = {
    name: "test-world-ir-consumer",
    pluginId: "test-world-ir-consumer",
    description: "Captures the shared typed WorldIR slot.",
    stage: "post-turn",
    runtimeType: "function",
    handler: "./unused.js",
    outputKind: "system",
    trigger: { type: "auto" },
    inputs: {
      worldIR: {
        from: { capability: "world-ir-provider@1", cardinality: "one" },
        accepts: "contract:world-ir@1",
        required: true,
      },
    },
  };
  const llm = new PipelineLLM(worldIrContent, tamper);
  const hookPipeline = createHookPipeline();
  hookPipeline.register({
    id: "own-facts-review",
    pluginId: "world-ir",
    event: "ReviewAgentOutput",
    handler: async (ctx, payload) => {
      const reviewed = reviewWorldFacts(ctx, payload);
      return {
        action: "continue",
        ...(reviewed.replace ? { replace: reviewed.replace } : {}),
      };
    },
  });
  const submitWorldFacts = makeSubmitWorldFacts({ tool });
  const toolExecutor = createToolExecutor({
    findTool: (name) =>
      name === "submit-world-facts" ? submitWorldFacts : undefined,
  });
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
    origin: "player",
    sessionId: "session-world-ir",
    turnId: "turn-world-ir",
    playerMessage: "Search the desk.",
  };

  const result = await runTurnPipeline(
    input,
    [narrator.manifest, worldIr.manifest, consumer],
    {
      llm,
      hookPipeline,
      toolExecutor,
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
    expect(extractorCall?.responseFormat).toBeUndefined();
    expect(extractorCall?.tools?.map((tool) => tool.name)).toEqual([
      "submit-world-facts",
      "submit-output",
    ]);
    expect(extractorCall?.tools?.[0]?.parameters).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["entities", "relations", "events", "statements"],
      properties: {
        schemaVersion: { const: 1, default: 1 },
        entities: { type: "array" },
        relations: { type: "array" },
        events: { type: "array" },
        statements: { type: "array" },
      },
    });
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

  it("corrects a changed canonical submission without repeating extraction", async () => {
    const { result } = await runPipeline(JSON.stringify(VALID_WORLD_IR), true);
    const facts = result.runtimeResults.find(
      (r) => r.runtimeId === "world-ir",
    )!;
    expect(facts.status, facts.error).toBe("success");
    expect(facts.output).toEqual(VALID_WORLD_IR);
    expect(facts.toolCalls.map((call) => call.toolName)).toEqual([
      "submit-world-facts",
      "submit-output",
      "submit-output",
    ]);
    expect(facts.toolCalls[1]?.output).toMatchObject({
      error: { code: "review-rejected" },
    });
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
    const { result, observedInputs, llm } = await runPipeline(
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
    // With the larger budget this permanently invalid model reaches the
    // repeated-call guard. It must still receive the original validation error.
    expect(byRuntime.get("world-ir")?.error).toContain("tool-loop detected");
    expect(
      llm.calls
        .flatMap((call) => call.messages)
        .some(
          (message) =>
            message.role === "tool" &&
            typeof message.content === "string" &&
            message.content.includes("does not exist"),
        ),
    ).toBe(true);
    expect(byRuntime.get("test-world-ir-consumer")?.status).toBe("skipped");
    expect(byRuntime.get("test-world-ir-consumer")?.output).toMatchObject({
      reason: "upstream-failed",
      skippedBy: "framework:inputBinding",
    });
    expect(observedInputs).toEqual([]);
  });
});
