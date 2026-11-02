/** Loaded output schemas belong to the generated submission tool. */
import { describe, it, expect, vi } from "vitest";
import type {
  LLMResponse,
  RuntimeManifest,
  RuntimeResult,
} from "@covel/shared";
import { createMemoryStore } from "@covel/store/memory";
import { runTurnPipeline } from "../src/turn-executor/turn-executor.js";
import { createHookPipeline } from "../src/hooks/pipeline.js";
import { queuedLLM, toolCall } from "./_helpers/agent-loop-fixture.js";
import type { ToolExecutor } from "../src/agent-loop/tool-executor.js";

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["prompt"],
  properties: { prompt: { type: "string", minLength: 1 } },
};
async function run(
  script: readonly LLMResponse[],
  options: { business?: boolean; rewrite?: boolean } = {},
) {
  const manifest: RuntimeManifest = {
    name: "author/prompt",
    pluginId: "author",
    description: "Produce an illustration prompt",
    stage: "setup",
    outputKind: "system",
    runtimeType: "agent",
    output: { schema: "output.schema.json" },
    ...(options.business
      ? {
          tools: { plugin: ["prepare"] },
          requireToolUse: true,
          completeAfterTools: ["prepare"],
        }
      : {}),
    maxRetries: 0,
  };
  const llm = queuedLLM(script);
  const execute = vi.fn<ToolExecutor["execute"]>(async (call) => ({
    toolCallId: call.toolCallId,
    name: call.name,
    result: '{"data":{"canonical":"a portrait"}}',
    parsedResult: { canonical: "a portrait" },
    success: true,
    approvalStatus: "auto-allowed",
  }));
  const pipeline = createHookPipeline();
  if (options.rewrite)
    pipeline.register({
      id: "rewrite",
      event: "PostRuntime",
      handler: async (_ctx, payload) => ({
        action: "continue",
        replace: {
          result: {
            ...(payload as { result: RuntimeResult }).result,
            output: { wrong: true },
          },
        },
      }),
    });
  const turn = await runTurnPipeline(
    { sessionId: "s", turnId: "t", origin: "player", playerMessage: "Start" },
    [manifest],
    {
      store: createMemoryStore(),
      llm,
      hookPipeline: pipeline,
      loadRuntime: async () => ({
        manifest,
        promptTemplate: "Read canonical work, then submit the final output.",
        outputSchema: schema,
      }),
      ...(options.business
        ? {
            toolExecutor: {
              execute,
              getToolInfo: (name) => ({
                name,
                description: "Prepare context",
                annotations: {
                  readOnly: true,
                  stagesWrites: false,
                  idempotent: true,
                  concurrencySafe: true,
                },
                jsonSchema: { type: "object" },
              }),
            },
          }
        : {}),
    },
    { maxSteps: 5 },
  );
  return { result: turn.runtimeResults[0]!, llm, execute };
}

describe("agent output schema", () => {
  it("advertises the unchanged schema through submit-output without responseFormat", async () => {
    const { result, llm, execute } = await run([
      toolCall("submit-output", { prompt: "a portrait" }),
    ]);
    expect(result.status, result.error).toBe("success");
    expect(result.output).toEqual({ prompt: "a portrait" });
    expect(llm.requests[0]?.responseFormat).toBeUndefined();
    expect(llm.requests[0]?.tools).toEqual([
      expect.objectContaining({ name: "submit-output", parameters: schema }),
    ]);
    expect(execute).not.toHaveBeenCalled();
  });
  it("offers the generated tool alongside declared business tools", async () => {
    const { result, llm } = await run(
      [
        toolCall("prepare", {}),
        toolCall("submit-output", { prompt: "a portrait" }),
      ],
      { business: true },
    );
    expect(result.status, result.error).toBe("success");
    expect(llm.requests[0]?.tools?.map((t) => t.name)).toEqual([
      "prepare",
      "submit-output",
    ]);
  });
  it("uses submitted output after business work rather than promoting a tool result", async () => {
    const { result, execute } = await run(
      [
        toolCall("prepare", {}),
        toolCall("submit-output", { prompt: "a portrait" }),
      ],
      { business: true },
    );
    expect(result.output).toEqual({ prompt: "a portrait" });
    expect(execute).toHaveBeenCalledOnce();
  });
  it("rejects wrong shapes without exposing a failed candidate as output", async () => {
    const { result, llm } = await run([
      toolCall("submit-output", { wrong: true }),
    ]);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("invalid-output");
    expect(result.output).toBeNull();
    expect(llm.requests).toHaveLength(2);
    expect(JSON.stringify(llm.requests[1]?.messages)).toContain("prompt");
  });
  it("corrects an invalid final submission without repeating work", async () => {
    const { result, llm, execute } = await run(
      [
        toolCall("prepare", {}),
        toolCall("submit-output", { wrong: true }),
        toolCall("submit-output", { prompt: "a portrait" }),
      ],
      { business: true },
    );
    expect(result.status, result.error).toBe("success");
    expect(llm.requests).toHaveLength(3);
    expect(execute).toHaveBeenCalledOnce();
  });
  it("rejects malformed complete arguments with correlated tool errors", async () => {
    const invalid = toolCall("submit-output", {});
    const { result, llm } = await run([
      {
        ...invalid,
        toolCalls: [
          { id: "bad-json", name: "submit-output", arguments: '{"prompt":' },
        ],
      },
    ]);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("invalid-json");
    expect(result.output).toBeNull();
    expect(llm.requests[1]?.messages).toContainEqual(
      expect.objectContaining({ role: "tool", toolCallId: "bad-json" }),
    );
  });
  it("defensively rejects a post-runtime rewrite outside the admitted schema", async () => {
    const { result } = await run(
      [toolCall("submit-output", { prompt: "a portrait" })],
      { rewrite: true },
    );
    expect(result.status).toBe("failed");
    expect(result.error).toContain("output-schema-invalid");
    expect(result.output).toBeNull();
  });
});
