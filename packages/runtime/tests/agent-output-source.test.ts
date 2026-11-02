import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { tool, withModelView, suspendTool } from "@covel/tools";
import { createMemoryStore } from "@covel/store/memory";
import type { ReviewAgentOutputPayload } from "../src/hooks/wire-helpers.js";
import { createHookPipeline } from "../src/hooks/pipeline.js";
import { createTurnEmitter } from "../src/trace/turn-emitter.js";
import { collectExecutionSuspensions } from "../src/suspension-artifact.js";
import { resumeRuntimePipeline } from "../src/resume/turn-resume.js";
import {
  manifest,
  queuedLLM,
  runLoop,
  runRuntime,
  toolCall,
  makeExecutor,
} from "./_helpers/agent-loop-fixture.js";

const schema = {
  type: "object",
  properties: { value: { type: "integer" } },
  required: ["value"],
  additionalProperties: false,
};
function fixture(
  values: readonly unknown[] = [{ value: 1 }],
  concealed = false,
) {
  const runtime = manifest({
    tools: { plugin: ["calculate"], builtin: ["suspend"] },
    output: { from: { tool: "calculate" } },
    concealed,
  });
  let index = 0;
  const execute = vi.fn(async () =>
    withModelView(values[index++], {
      summary: "Alternate model view",
      data: { wrapper: "PRIVATE_MODEL_VIEW" },
    }),
  );
  const business = tool({
    name: "calculate",
    description: "Calculate a value",
    parameters: z.object({}),
    execute,
  });
  const loaded = {
    manifest: runtime,
    promptTemplate: "Calculate, then submit {}.",
    outputSchema: schema,
  };
  return {
    runtime,
    loaded,
    execute,
    executor: makeExecutor([business, suspendTool]),
  };
}
const work = (id = "work") => toolCall("calculate", {}, id);
const submit = (value: Record<string, unknown> = {}, id = "submit") =>
  toolCall("submit-output", value, id);
const rawSubmit = (argumentsJson: string, id = "submit") => {
  const response = submit({}, id);
  return {
    ...response,
    toolCalls: response.toolCalls.map((call) => ({
      ...call,
      arguments: argumentsJson,
    })),
  };
};
const errorFor = (
  llm: ReturnType<typeof queuedLLM>,
  request: number,
  id: string,
) =>
  llm.requests[request]?.messages.find((message) => message.toolCallId === id)
    ?.content;
function run(
  f: ReturnType<typeof fixture>,
  llm: ReturnType<typeof queuedLLM>,
  hookPipeline?: ReturnType<typeof createHookPipeline>,
) {
  return runLoop({
    llm,
    manifest: f.runtime,
    loaded: f.loaded,
    deps: { toolExecutor: f.executor },
    hookPipeline,
  });
}

describe("tool-sourced output", () => {
  it("accepts {} using public content with an empty advertised schema", async () => {
    const f = fixture();
    const llm = queuedLLM([work(), submit()]);
    expect((await run(f, llm)).acceptedOutput).toEqual({ value: 1 });
    expect(f.execute).toHaveBeenCalledOnce();
    expect(
      llm.requests[0]?.tools?.find((tool) => tool.name === "submit-output"),
    ).toMatchObject({
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      description: expect.stringContaining("calculate"),
    });
  });
  it.each([
    '{"value":99}',
    '{"parameters":{}}',
    '{"arguments":{}}',
    '{"unknown":true}',
    '{"value":',
    "",
    "[]",
    "null",
    "42",
  ])(
    "ignores submission arguments %j without repeating business work",
    async (argumentsJson) => {
      const f = fixture();
      const llm = queuedLLM([work(), rawSubmit(argumentsJson)]);
      const result = await run(f, llm);
      expect(result.acceptedOutput).toEqual({ value: 1 });
      expect(llm.requests).toHaveLength(2);
      expect(f.execute).toHaveBeenCalledOnce();
    },
  );
  it("charges missing work to toolUse then accepts after success", async () => {
    const f = fixture();
    const llm = queuedLLM([
      rawSubmit('{"parameters":', "early"),
      work(),
      submit(),
    ]);
    f.runtime = {
      ...f.runtime,
      loopProfile: { corrections: { outputRepair: 0, toolUse: 1 } },
    };
    f.loaded = { ...f.loaded, manifest: f.runtime };
    const result = await run(f, llm);
    expect(errorFor(llm, 1, "early")).toContain("required-work");
    expect(errorFor(llm, 1, "early")).toContain("calculate");
    expect(llm.requests).toHaveLength(3);
    expect(result.acceptedOutput).toEqual({ value: 1 });
  });
  it("selects the latest successful call", async () => {
    const f = fixture([{ value: 1 }, { value: 2 }]);
    const llm = queuedLLM([work("one"), work("two"), submit()]);
    expect((await run(f, llm)).acceptedOutput).toEqual({ value: 2 });
    expect(f.execute).toHaveBeenCalledTimes(2);
  });
  it("ignores a later failed call when choosing the latest successful result", async () => {
    const f = fixture();
    f.execute.mockImplementationOnce(async () =>
      withModelView({ value: 7 }, {}),
    );
    f.execute.mockRejectedValueOnce(new Error("Tool failed"));
    const llm = queuedLLM([work("success"), work("failed"), submit()]);
    const result = await run(f, llm);
    expect(result.acceptedOutput).toEqual({ value: 7 });
    expect(result.executedToolCalls.map((call) => call.success)).toEqual([
      true,
      false,
    ]);
  });
  it("does not accept a failed call as source work", async () => {
    const f = fixture();
    f.execute.mockRejectedValueOnce(new Error("Tool failed"));
    const llm = queuedLLM([
      work("failed"),
      submit({}, "missing"),
      work("success"),
      submit(),
    ]);
    const result = await run(f, llm);
    expect(errorFor(llm, 2, "missing")).toContain("required-work");
    expect(result.acceptedOutput).toEqual({ value: 1 });
  });
  it("uses executor content even when PostToolUse rewrites its visible result", async () => {
    const f = fixture();
    const pipeline = createHookPipeline();
    pipeline.register({
      id: "display",
      event: "PostToolUse",
      handler: async () => ({
        action: "continue",
        replace: {
          result: {
            success: true,
            parsedResult: { value: 999 },
            result: "display-only",
          },
        },
      }),
    });
    const result = await run(f, queuedLLM([work(), submit()]), pipeline);
    expect(result.acceptedOutput).toEqual({ value: 1 });
  });
  it("rejects schema-invalid canonical content", async () => {
    const f = fixture([{ value: "wrong" }]);
    const llm = queuedLLM([
      work(),
      submit({ value: 1, parameters: {} }, "bad"),
      rawSubmit("malformed"),
    ]);
    const result = await run(f, llm);
    expect(errorFor(llm, 2, "bad")).toContain("invalid-output");
    expect(result.acceptedOutput).toBeNull();
    expect(result.stop.reason).toBe("invalid-output");
  });
  it("reviews the canonical candidate once per correlated submission", async () => {
    const f = fixture();
    const pipeline = createHookPipeline();
    const seen: ReviewAgentOutputPayload[] = [];
    pipeline.register<ReviewAgentOutputPayload>({
      id: "review",
      event: "ReviewAgentOutput",
      handler: async (_ctx, payload) => {
        seen.push(payload);
        return {
          action: "continue",
          ...(seen.length === 1
            ? { replace: { correction: "Review again" } }
            : {}),
        };
      },
    });
    const llm = queuedLLM([
      work(),
      submit({ parameters: {}, value: 99 }, "rejected"),
      rawSubmit("malformed", "accepted"),
    ]);
    const result = await run(f, llm, pipeline);
    expect(errorFor(llm, 2, "rejected")).toContain("review-rejected");
    expect(
      seen.map((payload) => [payload.toolCall.id, payload.output]),
    ).toEqual([
      ["rejected", { value: 1 }],
      ["accepted", { value: 1 }],
    ]);
    expect(result.acceptedOutput).toEqual({ value: 1 });
    expect(f.execute).toHaveBeenCalledOnce();
  });
  it("restores canonical content after suspension without rerunning work", async () => {
    const f = fixture();
    const store = createMemoryStore();
    const llm = queuedLLM([
      work(),
      toolCall(
        "suspend",
        {
          reason: "Confirm",
          fields: [{ name: "answer", label: "Answer", type: "text" }],
        },
        "wait",
      ),
      submit(),
    ]);
    const deps = {
      store,
      toolExecutor: f.executor,
      loadRuntime: async () => f.loaded,
    };
    const suspended = await runRuntime({ llm, manifest: f.runtime, deps });
    expect(suspended.status, suspended.error).toBe("suspended");
    const [artifact] = collectExecutionSuspensions({
      runtimeResults: [suspended],
    });
    expect(artifact).toBeDefined();
    expect(artifact?.pendingContinuation.loop?.outputContract.from).toEqual({
      tool: "calculate",
    });
    const result = await resumeRuntimePipeline(
      JSON.parse(JSON.stringify(artifact)),
      {},
      f.runtime,
      { ...deps, llm },
    );
    expect(result.status, result.error).toBe("success");
    expect(result.output).toEqual({ value: 1 });
    expect(f.execute).toHaveBeenCalledOnce();
  });
  it("keeps concealed candidates and corrections out of projections", async () => {
    const f = fixture([{ value: 732019 }], true);
    const events: unknown[] = [];
    const emitter = createTurnEmitter({
      sessionId: "sess-loop",
      turnId: "turn-loop",
      concealedRuntimeIds: new Set([f.runtime.name]),
      store: {
        addTraceEvent: async (event) => {
          events.push(event);
        },
      },
    });
    const pipeline = createHookPipeline();
    pipeline.register({
      id: "review",
      event: "ReviewAgentOutput",
      handler: async () => ({
        action: "continue",
        replace: { correction: "PRIVATE_REVIEW" },
      }),
    });
    const result = await runRuntime({
      manifest: f.runtime,
      llm: queuedLLM([work(), submit()]),
      deps: {
        toolExecutor: f.executor,
        loadRuntime: async () => f.loaded,
        emitter,
        hookPipeline: pipeline,
      },
    });
    expect(result.status).toBe("failed");
    expect(JSON.stringify(events)).toContain("output-rejected");
    expect(JSON.stringify(events)).not.toMatch(/PRIVATE_|732019/);
  });
});
