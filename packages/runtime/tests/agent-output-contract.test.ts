import { describe, expect, it } from "vitest";
import type { RuntimeManifest, TurnInput } from "@covel/shared";
import {
  resolveAgentOutput,
  type LoadedRuntime,
} from "@covel/shared/plugin-runtime";
import { buildAgentLoopPolicy } from "../src/agent-loop/agent-loop-policy.js";
import { prepareAgentToolSurface } from "../src/agent-loop/agent-tool-surface.js";
import { createToolExecutor } from "../src/agent-loop/tool-executor.js";
import { resolveFrameworkCompletion } from "@covel/context";
import { hasBusinessWork } from "../src/agent-loop/runtime-completion.js";
import { validateOutput } from "@covel/tools";
import { outputToolDefinition } from "../src/agent-loop/agent-output-contract.js";

const manifest: RuntimeManifest = {
  name: "example/extract",
  pluginId: "example",
  description: "Extract facts",
  runtimeType: "agent",
  outputKind: "system",
  trigger: { type: "manual" },
};
const schema = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
};
const input: TurnInput = {
  sessionId: "session",
  turnId: "turn",
  playerMessage: "Look",
  origin: "player",
  locale: "en-US",
};
function policy(loaded: LoadedRuntime) {
  return buildAgentLoopPolicy({
    manifest: loaded.manifest,
    loaded,
    input,
    timeoutMs: 10000,
    maxSteps: 3,
    deps: {
      llm: {
        generate: async () => {
          throw new Error("Unexpected model call");
        },
      },
    },
  });
}

describe("generated output contract", () => {
  it("advertises localized completion guidance before a first submission", async () => {
    const output = resolveAgentOutput({ manifest, promptTemplate: "" });
    const tool = await outputToolDefinition(output, "zh-CN");
    expect(tool.description).toContain("普通非 setup 运行省略 preGameDone");
    expect(tool.description).toContain('false + "pending" 或 true + "done"');
    expect(tool.description).toContain("不表示“当前不是 setup”");
  });

  it("advertises the same loaded schema for story and system without a business registry", async () => {
    for (const outputKind of ["story", "system"] as const) {
      const result = await policy({
        manifest: { ...manifest, outputKind },
        promptTemplate: "",
        outputSchema: schema,
      });
      expect(result.toolDefs).toEqual([
        expect.objectContaining({
          name: "submit-output",
          parameters: schema,
          strict: "auto",
        }),
      ]);
      expect(result.responseFormat).toBeUndefined();
      expect([...result.authorizedToolNames]).toEqual(["submit-output"]);
    }
  });

  it("uses host defaults only when no schema has loaded", () => {
    const system = resolveAgentOutput({ manifest, promptTemplate: "" });
    expect(validateOutput({}, system.schema).valid).toBe(true);
    expect(
      validateOutput(
        { completion: "done", preGameDone: true, custom: 1 },
        system.schema,
      ).valid,
    ).toBe(true);
    expect(validateOutput({ completion: "unknown" }, system.schema).valid).toBe(
      false,
    );
    const story = resolveAgentOutput({
      manifest: { ...manifest, outputKind: "story" },
      promptTemplate: "",
    });
    expect(validateOutput({ narrativeOutput: "  " }, story.schema).valid).toBe(
      false,
    );
    expect(
      validateOutput(
        { narrativeOutput: "A door opens.", yield: "user" },
        story.schema,
      ).valid,
    ).toBe(true);
  });

  it("keeps concurrent runtimes' schemas isolated and frozen", async () => {
    const loaded = [
      schema,
      { type: "object", properties: { count: { type: "integer" } } },
    ].map((outputSchema) => ({ manifest, outputSchema, promptTemplate: "" }));
    const surfaces = await Promise.all(
      loaded.map((value) =>
        prepareAgentToolSurface({ manifest, loaded: value, input, deps: {} }),
      ),
    );
    for (const [i, surface] of surfaces.entries()) {
      expect(surface.output?.schema).toEqual(loaded[i]?.outputSchema);
      expect(Object.isFrozen(surface.output?.schema)).toBe(true);
      expect(surface.output?.provenance).toBe("model-authored");
    }
    expect(surfaces[0]?.output).not.toBe(surfaces[1]?.output);
  });

  it("keeps submission active when all business tools are deferred", async () => {
    const loaded = {
      manifest: { ...manifest, tools: { defer: true as const } },
      promptTemplate: "",
    };
    const result = await policy(loaded);
    expect(result.toolDefs?.map((tool) => tool.name)).toEqual([
      "submit-output",
    ]);
    expect(result.deferredToolNames.has("submit-output")).toBe(false);
  });

  it("does not make host control calls into business work", async () => {
    const result = await policy({
      manifest: { ...manifest, requireToolUse: true },
      promptTemplate: "",
    });
    expect(result.output.requiredWork).toEqual({
      required: true,
      toolNames: [],
    });
    expect(result.output.provenance).toBe("model-authored");
  });

  it.each([{ type: "array" }, { type: "string" }, {}])(
    "rejects non-object schema admission: %j",
    async (outputSchema) => {
      await expect(
        policy({ manifest, promptTemplate: "", outputSchema }),
      ).rejects.toThrow(/parameters must describe an object/);
    },
  );

  it("uses a frozen loaded schema and validator without copying it into the prompt contract", async () => {
    const loaded = {
      manifest,
      promptTemplate: "",
      outputSchema: structuredClone(schema),
    };
    const result = await policy(loaded);
    loaded.outputSchema.properties.answer.type = "number";
    expect(result.output.validate({ answer: "yes" }).valid).toBe(true);
    expect(result.output.validate({ answer: 1 }).valid).toBe(false);
    expect(result.toolDefs?.[0]?.parameters).toBe(result.output.schema);
    expect(resolveFrameworkCompletion(manifest, result.output)).toEqual({
      completion: "submit-output",
      requiredWork: result.output.requiredWork,
    });
  });

  it.each([
    { builtin: ["submit-output"] },
    { plugin: ["submit-output"] },
    { services: [{ contract: "facts@1", name: "submit-output" }] },
    { defer: ["submit-output"] },
  ])("rejects programmatic tool collisions: %j", async (tools) => {
    const loaded = { manifest: { ...manifest, tools }, promptTemplate: "" };
    await expect(policy(loaded)).rejects.toThrow(/submit-output.*reserved/);
    await expect(
      prepareAgentToolSurface({
        manifest: loaded.manifest,
        input,
        loaded,
        deps: {},
      }),
    ).rejects.toThrow(/submit-output.*reserved/);
  });

  it.each([
    "submit-output",
    "search-tools",
    "suspend",
    "delegate",
    "delegate-batch",
  ])("never counts %s as successful business work", (name) => {
    expect(
      hasBusinessWork(manifest, [
        { name, arguments: "{}", result: {}, success: true },
      ]),
    ).toBe(false);
  });

  it("keeps required-work evidence separate from the output schema", () => {
    const required = {
      ...manifest,
      requireToolUse: true,
      completeAfterTools: ["save"],
    };
    expect(
      hasBusinessWork(required, [
        { name: "read", arguments: "{}", result: {}, success: true },
      ]),
    ).toBe(false);
    expect(
      hasBusinessWork(required, [
        { name: "save", arguments: "{}", result: {}, success: false },
      ]),
    ).toBe(false);
    expect(
      hasBusinessWork(required, [
        { name: "save", arguments: "{}", result: {}, success: true },
      ]),
    ).toBe(true);
  });

  it("does not expose submission through the ordinary executor", async () => {
    const executor = createToolExecutor({});
    try {
      const result = await executor.execute(
        { toolCallId: "call", name: "submit-output", arguments: "{}" },
        {
          sessionId: "session",
          turnId: "turn",
          pluginId: "example",
          runtimeId: "example/function",
          authorizedToolNames: new Set(),
        },
      );
      expect(result.success).toBe(false);
      expect(result.pendingProposals).toBeUndefined();
    } finally {
      await executor.close();
    }
  });
});

it("freezes the source identity with the admitted output schema", () => {
  const from = { tool: "save-facts" };
  const loaded = {
    manifest: {
      ...manifest,
      tools: { plugin: ["save-facts"] },
      output: { from },
    },
    promptTemplate: "",
    outputSchema: schema,
  };
  const effective = resolveAgentOutput(loaded);
  from.tool = "different";
  expect(effective.from).toEqual({ tool: "save-facts" });
  expect(Object.isFrozen(effective.from)).toBe(true);
  expect(effective.provenance).toBe("tool-result");
});

it.each([
  { output: { from: { tool: "save-facts" } }, tools: undefined },
  {
    output: { from: { tool: "submit-output" } },
    tools: { plugin: ["submit-output"] },
  },
])("rejects programmatic invalid sources: %j", (fields) => {
  expect(() =>
    resolveAgentOutput({
      manifest: { ...manifest, ...fields },
      promptTemplate: "",
      outputSchema: schema,
    }),
  ).toThrow(/authorized own or builtin/);
});
it("rejects a programmatic source without a loaded schema", () => {
  expect(() =>
    resolveAgentOutput({
      manifest: {
        ...manifest,
        output: { from: { tool: "save-facts" } },
        tools: { plugin: ["save-facts"] },
      },
      promptTemplate: "",
    }),
  ).toThrow(/requires a loaded output schema or contract/);
});
