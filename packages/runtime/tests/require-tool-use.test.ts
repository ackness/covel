/** Business prerequisites are checked when final output is submitted. */
import { describe, it, expect } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import { createEmitEventTool, tool, z } from "@covel/tools";
import { runTurnPipeline } from "../src/turn-executor/turn-executor.js";
import { createToolExecutor } from "../src/agent-loop/tool-executor.js";
import { queuedLLM, toolCall } from "./_helpers/agent-loop-fixture.js";
import type { LLMResponse, RuntimeManifest } from "@covel/shared";

const submit = () => toolCall("submit-output", {});
const work = () =>
  toolCall("emit-event", { topic: "test.ping", data: { x: 1 } });
async function run(
  script: readonly LLMResponse[],
  locale = "en-US",
  required = true,
  repair = false,
) {
  const store = createMemoryStore();
  const emit = createEmitEventTool({
    directory: {
      listTopics: async () => ["test.ping"],
      validate: async () => ({ ok: true }),
    },
  });
  let attempts = 0;
  const failed = tool({
    name: "flaky",
    description: "Required work",
    parameters: z.object({}),
    execute: async () => {
      if (!repair || attempts++ === 0) throw new Error("Unavailable");
      return { saved: true };
    },
  });
  const llm = queuedLLM(script);
  const manifest: RuntimeManifest = {
    name: "plug/gated",
    pluginId: "plug",
    description: "Save work then submit",
    stage: "post-turn",
    outputKind: "system",
    runtimeType: "agent",
    requireToolUse: required,
    tools: { plugin: ["emit-event", "flaky"] },
    maxRetries: 0,
  };
  const result = await runTurnPipeline(
    {
      sessionId: "s",
      turnId: "t",
      origin: "player",
      playerMessage: "Continue",
      locale,
    },
    [manifest],
    {
      store,
      llm,
      loadRuntime: async () => ({
        manifest,
        promptTemplate: "Complete the work, then submit.",
      }),
      toolExecutor: createToolExecutor({
        store,
        findTool: (name) => [emit, failed].find((t) => t.name === name),
      }),
    },
    { maxSteps: 6 },
  );
  return { result: result.runtimeResults[0]!, llm };
}

describe("required business work", () => {
  it("corrects a premature submission with work and one final submission", async () => {
    const { result, llm } = await run([submit(), work(), submit()]);
    expect(result.status, result.error).toBe("success");
    expect(llm.requests).toHaveLength(3);
    expect(result.effects?.events).toEqual([
      { topic: "test.ping", data: { x: 1 } },
    ]);
    expect(result.toolCalls.map((call) => call.toolName)).toEqual([
      "submit-output",
      "emit-event",
      "submit-output",
    ]);
  });
  it.each(["zh-CN", "zh-TW"])(
    "localizes required-work feedback for %s",
    async (locale) => {
      const { result, llm } = await run([submit(), work(), submit()], locale);
      expect(result.status, result.error).toBe("success");
      const feedback = JSON.stringify(llm.requests[1]?.messages);
      expect(feedback).toContain(
        locale === "zh-CN" ? "业务工具工作" : "business tool work",
      );
    },
  );
  it("fails bounded repeated submissions with no business work", async () => {
    const { result, llm } = await run([submit()]);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("required-work");
    expect(llm.requests).toHaveLength(2);
  });
  it("accepts an initial business call followed by explicit submission", async () => {
    const { result, llm } = await run([work(), submit()]);
    expect(result.status, result.error).toBe("success");
    expect(llm.requests).toHaveLength(2);
  });
  it.each([false, true])(
    "requires same-tool recovery after failure (repaired=%s)",
    async (repair) => {
      const { result } = await run(
        [
          toolCall("flaky", {}),
          work(),
          ...(repair ? [toolCall("flaky", {})] : []),
          submit(),
        ],
        "en-US",
        true,
        repair,
      );
      expect(result.status, result.error).toBe(repair ? "success" : "failed");
      if (!repair) expect(result.error).toContain("required-work");
    },
  );
  it("accepts a no-change object immediately when no work is required", async () => {
    const { result, llm } = await run([submit()], "en-US", false);
    expect(result.status, result.error).toBe("success");
    expect(result.output).toEqual({});
    expect(llm.requests).toHaveLength(1);
  });
  it("never treats reply prose as required business work", async () => {
    const { result } = await run([
      {
        content: "Already saved",
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("missing-submission");
  });
});
