import { afterEach, describe, expect, it, vi } from "vitest";
import * as handler from "../src/agent-loop/tool-loop-handler.js";
import { createHookPipeline } from "../src/hooks/pipeline.js";
import {
  manifest,
  queuedLLM,
  runLoop,
  submitted,
  toolCall,
} from "./_helpers/agent-loop-fixture.js";

afterEach(() => vi.restoreAllMocks());

describe("submission request routing", () => {
  it("requests the initial submission after required work without repeating the named business tool", async () => {
    const requests = vi.spyOn(handler, "requestLLMResponse");
    const llm = queuedLLM([
      toolCall("mark", { note: "once" }),
      submitted("done"),
    ]);
    await runLoop({
      llm,
      manifest: manifest({
        requireToolUse: true,
        completeAfterTools: ["mark"],
        llm: { toolChoice: { name: "mark" } },
      }),
    });
    expect(
      requests.mock.calls.map(([request]) => request.submissionRequested),
    ).toEqual([false, true]);
    expect(llm.requests.map((request) => request.defaults?.toolChoice)).toEqual(
      [{ name: "mark" }, { name: "submit-output" }],
    );
  });

  it("marks the initial no-business-tool request and the single reserve request as submission requests", async () => {
    const requests = vi.spyOn(handler, "requestLLMResponse");
    await runLoop({
      llm: queuedLLM([submitted("done")]),
      manifest: manifest({ tools: undefined }),
    });
    expect(requests.mock.calls[0]?.[0].submissionRequested).toBe(true);
    requests.mockClear();
    await runLoop({
      llm: queuedLLM([toolCall("mark", { note: "once" }), submitted("done")]),
      maxSteps: 1,
    });
    expect(
      requests.mock.calls.map(([request]) => request.submissionRequested),
    ).toEqual([false, true]);
  });

  it("prefers resubmission over a hook's named business choice after a rejected submission", async () => {
    const requests = vi.spyOn(handler, "requestLLMResponse");
    const pipeline = createHookPipeline();
    pipeline.register({
      id: "choice",
      event: "PreStep",
      handler: async () => ({
        action: "continue",
        replace: { toolChoice: { name: "mark" } },
      }),
    });
    const bad = {
      ...submitted(""),
      toolCalls: [{ id: "bad", name: "submit-output", arguments: "{" }],
    };
    const llm = queuedLLM([bad, submitted("done")]);
    await runLoop({ llm, hookPipeline: pipeline });
    expect(
      requests.mock.calls.map(([request]) => request.submissionRequested),
    ).toEqual([false, true]);
    expect(llm.requests[1]?.defaults?.toolChoice).toEqual({
      name: "submit-output",
    });
  });

  it("keeps the business-work correction's named choice until its prerequisites succeed", async () => {
    const requests = vi.spyOn(handler, "requestLLMResponse");
    const pipeline = createHookPipeline();
    pipeline.register({
      id: "choice",
      event: "PreStep",
      handler: async () => ({
        action: "continue",
        replace: { toolChoice: { name: "mark" } },
      }),
    });
    const llm = queuedLLM([
      submitted("early"),
      toolCall("mark", { note: "once" }),
      submitted("done"),
    ]);
    await runLoop({
      llm,
      manifest: manifest({ requireToolUse: true }),
      hookPipeline: pipeline,
    });
    expect(
      requests.mock.calls.map(([request]) => request.submissionRequested),
    ).toEqual([false, false, true]);
    expect(llm.requests[1]?.defaults?.toolChoice).toEqual({ name: "mark" });
  });
});
