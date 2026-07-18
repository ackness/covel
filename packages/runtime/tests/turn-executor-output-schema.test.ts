import { describe, expect, it } from "vitest";
import type { RuntimeManifest, TurnInput } from "@covel/shared";
import { createMemoryStore } from "@covel/store";
import { executeTurn } from "../src/turn-executor/turn-executor.js";
import type { TurnExecutorDeps } from "../src/turn-executor/turn-executor.js";
import type { LLMAdapter, LLMResponse } from "../src/llm/llm-adapter.js";
import type { ToolExecutor } from "../src/agent-loop/tool-executor.js";

class CapturingLLM implements LLMAdapter {
  responseFormat: unknown;
  tools: unknown;
  content = '{"ok":true}';

  async generate(
    params: Parameters<LLMAdapter["generate"]>[0],
  ): Promise<LLMResponse> {
    this.responseFormat = params.responseFormat;
    this.tools = params.tools;
    return {
      content: this.content,
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
}

function manifest(overrides: Partial<RuntimeManifest> = {}): RuntimeManifest {
  return {
    name: "test-plugin/prompt-generator",
    pluginId: "test-plugin",
    description: "prompt generator",
    priority: 10,
    runtimeType: "agent",
    trigger: { type: "auto" },
    outputKind: "plugin",
    ...overrides,
  } as RuntimeManifest;
}

describe("executeTurn: output.schema.json", () => {
  it("passes loaded outputSchema as json_schema responseFormat", async () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        ok: { type: "boolean" },
      },
      required: ["ok"],
    };
    const llm = new CapturingLLM();
    const input: TurnInput = {
      sessionId: "sess-schema",
      turnId: "turn-schema",
      playerMessage: "start",
    };
    const runtime = manifest();
    const deps: TurnExecutorDeps = {
      loadRuntime: async (m) => ({
        manifest: m,
        promptTemplate: "Return JSON.",
        outputSchema: schema,
      }),
      llm,
      store: createMemoryStore(),
    };

    await executeTurn(input, [runtime], deps);

    expect(llm.responseFormat).toEqual({
      type: "json_schema",
      schema,
    });
  });

  it("does not auto-inject runtime-done for schema-declared agent runtimes", async () => {
    const schema = {
      type: "object",
      properties: {
        prompt: { type: "string" },
      },
      required: ["prompt"],
    };
    const llm = new CapturingLLM();
    const input: TurnInput = {
      sessionId: "sess-schema-tools",
      turnId: "turn-schema-tools",
      playerMessage: "start",
    };
    const runtime = manifest({
      output: { schema: "./output.schema.json" },
      tools: { builtin: ["plugin-data-set"] },
    });
    const toolExecutor: ToolExecutor = {
      async execute() {
        throw new Error("not used");
      },
      getToolInfo: (name) => ({
        name,
        description: `Tool ${name}`,
        jsonSchema: { type: "object", additionalProperties: true },
      }),
    };
    const deps: TurnExecutorDeps = {
      loadRuntime: async (m) => ({
        manifest: m,
        promptTemplate: "Return JSON.",
        outputSchema: schema,
      }),
      llm,
      store: createMemoryStore(),
      toolExecutor,
    };

    await executeTurn(input, [runtime], deps);

    expect(
      (llm.tools as Array<{ name: string }>).map((tool) => tool.name),
    ).toEqual(["plugin-data-set"]);
  });

  it("fails schema-declared plugin runtimes when parsed JSON has the wrong shape", async () => {
    const schema = {
      type: "object",
      required: ["prompt", "promptMode", "events"],
      properties: {
        prompt: { type: "string" },
        promptMode: { type: "string" },
        events: { type: "array", minItems: 1 },
      },
    };
    const llm = new CapturingLLM();
    llm.content =
      '{"scene":{"location":"mistport"},"recent_events":["wrong envelope"]}';
    const input: TurnInput = {
      sessionId: "sess-schema-invalid",
      turnId: "turn-schema-invalid",
      playerMessage: "start",
    };
    const runtime = manifest({
      output: { schema: "./output.schema.json" },
    });
    const deps: TurnExecutorDeps = {
      loadRuntime: async (m) => ({
        manifest: m,
        promptTemplate: "Return JSON.",
        outputSchema: schema,
      }),
      llm,
      store: createMemoryStore(),
    };

    const result = await executeTurn(input, [runtime], deps);

    expect(result.runtimeResults[0]?.status).toBe("failed");
    expect(result.runtimeResults[0]?.error).toContain(
      "output did not match output.schema",
    );
    expect(result.runtimeResults[0]?.error).toContain(
      "must have required property 'prompt'",
    );
  });

  // Regression: when an LLM returns plain prose for a schema-declared runtime,
  // the failure must surface (a) the required-field hint so the user knows what
  // the model should have emitted, (b) the full LLM output preserved in
  // `output.narrativeOutput`, and (c) a structured `output.diagnostic` block so
  // the plugin's task UI can render schema vs raw output side-by-side. Before
  // this contract, the user only saw a 220-char preview and a vague "model
  // emitted unparseable prose" message — the openai-image-gen prompt-generator
  // failure in cloudmere-682fb5bf was the trigger for this work.
  it("enriches schema-prose failure with required fields, full LLM output, and diagnostic", async () => {
    const schema = {
      title: "openai-image-gen/prompt-generator output",
      type: "object",
      required: ["prompt", "promptMode", "events"],
      properties: {
        prompt: { type: "string" },
        promptMode: { type: "string" },
        events: { type: "array" },
      },
    };
    const llm = new CapturingLLM();
    const fullProse =
      "日落渡口。一身旧道袍的少年弟子盘膝坐于石砌渡口的末级台阶上".repeat(20);
    llm.content = fullProse;
    const input: TurnInput = {
      sessionId: "sess-prose",
      turnId: "turn-prose",
      playerMessage: "start",
    };
    const runtime = manifest({
      output: { schema: "./output.schema.json" },
    });
    const deps: TurnExecutorDeps = {
      loadRuntime: async (m) => ({
        manifest: m,
        promptTemplate: "Return JSON.",
        outputSchema: schema,
      }),
      llm,
      store: createMemoryStore(),
    };

    const result = await executeTurn(input, [runtime], deps);
    const failure = result.runtimeResults[0];

    expect(failure?.status).toBe("failed");
    expect(failure?.error).toContain(
      "expected a JSON envelope per output.schema",
    );
    // Required fields hint surfaces in the error string.
    expect(failure?.error).toContain("{prompt, promptMode, events}");
    // Pointer to where the full LLM output lives.
    expect(failure?.error).toContain("runtimeResults[].output.narrativeOutput");
    // Full LLM output preserved verbatim (no truncation in narrativeOutput).
    const output = failure?.output as Record<string, unknown> | null;
    expect(output?.narrativeOutput).toBe(fullProse);
    // Structured diagnostic for the task UI to render.
    const diagnostic = output?.diagnostic as
      Record<string, unknown> | undefined;
    expect(diagnostic?.kind).toBe("schema-validation-prose");
    expect(diagnostic?.requiredFields).toEqual([
      "prompt",
      "promptMode",
      "events",
    ]);
    expect(diagnostic?.schemaTitle).toBe(
      "openai-image-gen/prompt-generator output",
    );
    expect(diagnostic?.llmOutput).toBe(fullProse);
    expect(typeof diagnostic?.hint).toBe("string");
  });

  // Defence in depth: a malformed schema (missing or wrong-typed `required`)
  // must not crash the failure path. The error string still surfaces, just
  // without the field hint. This protects schema-validation diagnostics for
  // third-party plugins whose schemas may not follow JSON-Schema conventions.
  it("handles malformed schemas (no required[]) gracefully on prose failure", async () => {
    const schema = {
      type: "object",
      // No `required` array at all.
      properties: { ok: { type: "boolean" } },
    };
    const llm = new CapturingLLM();
    llm.content = "plain prose, not JSON";
    const input: TurnInput = {
      sessionId: "sess-malformed-schema",
      turnId: "turn-malformed-schema",
      playerMessage: "start",
    };
    const runtime = manifest({
      output: { schema: "./output.schema.json" },
    });
    const deps: TurnExecutorDeps = {
      loadRuntime: async (m) => ({
        manifest: m,
        promptTemplate: "Return JSON.",
        outputSchema: schema,
      }),
      llm,
      store: createMemoryStore(),
    };

    const result = await executeTurn(input, [runtime], deps);
    const failure = result.runtimeResults[0];

    expect(failure?.status).toBe("failed");
    expect(failure?.error).toContain(
      "expected a JSON envelope per output.schema",
    );
    // No required-field hint when schema lacks `required[]`.
    expect(failure?.error).not.toContain("Required fields:");
    const diagnostic = (failure?.output as Record<string, unknown>)
      ?.diagnostic as Record<string, unknown>;
    expect(diagnostic?.requiredFields).toEqual([]);
  });
});
