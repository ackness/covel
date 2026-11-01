import { afterEach, describe, expect, it, vi } from "vitest";
import type { LLMResponse, RuntimeManifest } from "@covel/shared";
import { createHookPipeline } from "../src/hooks/pipeline.js";
import type { ReviewAgentOutputPayload } from "../src/hooks/wire-helpers.js";
import { createTurnEmitter } from "../src/trace/turn-emitter.js";
import { createEventBus } from "@covel/events";
import {
  manifest,
  prose,
  queuedLLM,
  runLoop,
  runRuntime,
  toolCall,
  input,
  scriptedLLM,
} from "./_helpers/agent-loop-fixture.js";

const schema = {
  type: "object",
  properties: { answer: { type: "number" } },
  required: ["answer"],
};
const submit = (value: Record<string, unknown>, id = "submit") =>
  toolCall("submit-output", value, id);
const raw = (argumentsJson: string): LLMResponse => ({
  ...submit({}),
  toolCalls: [{ id: "bad", name: "submit-output", arguments: argumentsJson }],
});
const runtime = manifest({ output: { schema: "output.schema.json" } });
const loaded = {
  manifest: runtime,
  promptTemplate: "prompt",
  outputSchema: schema,
};
const run = (
  llm: ReturnType<typeof queuedLLM>,
  options: Omit<Parameters<typeof runLoop>[0], "llm"> = {},
) => runLoop({ llm, manifest: runtime, loaded, ...options });
const messagesText = (llm: ReturnType<typeof queuedLLM>, at = 1) =>
  JSON.stringify(
    llm.requests[at]?.messages.filter((message) => message.role === "tool"),
  );
afterEach(() => vi.useRealTimers());

describe("in-loop output correction", () => {
  it.each([
    ['{"answer":', "invalid-json"],
    ['{"answer":1} trailing', "invalid-json"],
    ['```json\n{"answer":1}\n```', "invalid-json"],
    ["[]", "invalid-output"],
    ["null", "invalid-output"],
    ['{"answer":"wrong"}', "invalid-output"],
    ["{}", "invalid-output"],
  ])(
    "rejects %s without salvage and accepts the next submission",
    async (text, code) => {
      const llm = queuedLLM([raw(text), submit({ answer: 2 })]);
      const loop = await run(llm);
      expect(loop.acceptedOutput).toEqual({ answer: 2 });
      expect(messagesText(llm)).toContain(code);
      expect(llm.requests).toHaveLength(2);
      expect(
        llm.requests.every((request) => request.responseFormat === undefined),
      ).toBe(true);
    },
  );

  it("uses bounded schema field diagnostics", async () => {
    const llm = queuedLLM([
      submit({ answer: "secret-value" }),
      submit({ answer: 1 }),
    ]);
    await run(llm);
    const feedback = messagesText(llm);
    expect(feedback).toContain("/answer");
    expect(feedback).not.toContain("secret-value");
  });

  it("reports syntax positions without inventing missing segments or quoting private text", async () => {
    const llm = queuedLLM([
      raw('{"answer":1},"secret":"PRIVATE"'),
      submit({ answer: 1 }),
    ]);
    await run(llm);
    const feedback = messagesText(llm);
    expect(feedback).toContain("after a closed root object");
    expect(feedback).toContain("offset");
    expect(feedback).not.toContain("segments");
    expect(feedback).not.toContain("PRIVATE");
  });

  it.each([0, 1, 2, 3])(
    "schedules exactly %i format corrections",
    async (outputRepair) => {
      const llm = queuedLLM([raw("{")]);
      const m = manifest({ loopProfile: { corrections: { outputRepair } } });
      const result = await runLoop({ llm, manifest: m, maxSteps: 10 });
      expect(result.stop.reason).toBe("invalid-output");
      expect(llm.requests).toHaveLength(outputRepair + 1);
      expect(result.acceptedOutput).toBeNull();
    },
  );

  it("keeps review, work and output-repair ceilings independent", async () => {
    const pipeline = createHookPipeline();
    let reviews = 0;
    pipeline.register<ReviewAgentOutputPayload>({
      id: "perspective",
      event: "ReviewAgentOutput",
      handler: async () => {
        reviews++;
        return reviews <= 2
          ? {
              action: "continue",
              replace: { correction: "Use the requested perspective." },
            }
          : { action: "continue" };
      },
    });
    const llm = queuedLLM([
      submit({}),
      toolCall("mark", { note: "once" }),
      raw("{"),
      submit({}),
      submit({}),
      submit({}),
    ]);
    const result = await runLoop({
      llm,
      manifest: manifest({ requireToolUse: true }),
      hookPipeline: pipeline,
      maxSteps: 8,
    });
    expect(result.acceptedOutput).toEqual({});
    expect(result.pendingProposals).toHaveLength(1);
    expect(reviews).toBe(3);
    expect(llm.requests).toHaveLength(6);
  });

  it("shares the review counter between response guards and candidate review", async () => {
    const pipeline = createHookPipeline();
    let responses = 0;
    let candidates = 0;
    pipeline.register({
      id: "guard",
      event: "PostLLMResponse",
      handler: async () =>
        ++responses === 1
          ? {
              action: "continue",
              replace: { correction: "Reject this response." },
            }
          : { action: "continue" },
    });
    pipeline.register({
      id: "review",
      event: "ReviewAgentOutput",
      handler: async () => {
        candidates++;
        return {
          action: "continue",
          replace: { correction: "Reject this candidate." },
        };
      },
    });
    const llm = queuedLLM([submit({ answer: 1 })]);
    const result = await run(llm, { hookPipeline: pipeline });
    expect(result.stop.reason).toBe("invalid-output");
    expect(responses).toBe(3);
    expect(candidates).toBe(2);
    expect(llm.requests).toHaveLength(3);
  });

  it("does not let another category rescue an exhausted format budget", async () => {
    const llm = queuedLLM([raw("{"), raw("{")]);
    const result = await run(llm);
    expect(result.stop.reason).toBe("invalid-output");
    expect(llm.requests).toHaveLength(2);
  });

  it("allows normal-step correction with under three seconds left", async () => {
    const llm = queuedLLM([raw("{"), submit({ answer: 1 })]);
    const result = await run(llm, { timeoutMs: 2000 });
    expect(result.acceptedOutput).toEqual({ answer: 1 });
  });

  it("uses one submission-only reserve request and never a second repair after it", async () => {
    const llm = queuedLLM([
      toolCall("mark", { note: "work" }),
      raw("{"),
      submit({ answer: 1 }),
    ]);
    const result = await run(llm, { maxSteps: 1 });
    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[1]!.tools?.map((tool) => tool.name)).toEqual([
      "submit-output",
    ]);
    expect(result.stop).toEqual({ reason: "max-steps" });
    expect(result.acceptedOutput).toBeNull();
  });

  it("keeps the finalizer submission-only after PreLLMCall tries to add a write", async () => {
    const pipeline = createHookPipeline();
    pipeline.register({
      id: "tools",
      event: "PreLLMCall",
      handler: async () => ({
        action: "continue",
        replace: {
          tools: [
            {
              name: "mark",
              description: "write",
              parameters: { type: "object" },
            },
          ],
        },
      }),
    });
    const llm = queuedLLM([
      toolCall("mark", { note: "once" }),
      submit({ answer: 1 }),
    ]);
    const result = await run(llm, { maxSteps: 1, hookPipeline: pipeline });
    expect(result.stop).toEqual({ reason: "max-steps", finalizer: true });
    expect(llm.requests[1]!.tools?.map((tool) => tool.name)).toEqual([
      "submit-output",
    ]);
    expect(result.pendingProposals).toHaveLength(1);
  });

  it("attributes repeated invalid submissions to output exhaustion even on the reserve step", async () => {
    const llm = queuedLLM([raw("{"), raw("{"), submit({ answer: 1 })]);
    const result = await run(llm, { maxSteps: 1 });
    expect(llm.requests).toHaveLength(2);
    expect(result.acceptedOutput).toBeNull();
    expect(result.stop).toEqual({ reason: "invalid-output" });
  });

  it("rejects business calls in the reserve request without staging another write", async () => {
    const llm = queuedLLM([
      toolCall("mark", { note: "once" }),
      toolCall("mark", { note: "twice" }),
    ]);
    const result = await run(llm, { maxSteps: 1 });
    expect(result.pendingProposals).toHaveLength(1);
    expect(result.acceptedOutput).toBeNull();
    expect(result.stop).toEqual({ reason: "max-steps" });
  });

  it("does not launch a reserve step while required business work is missing", async () => {
    const llm = queuedLLM([submit({})]);
    const result = await runLoop({
      llm,
      manifest: manifest({ requireToolUse: true }),
      maxSteps: 1,
    });
    expect(llm.requests).toHaveLength(1);
    expect(result.stop.reason).toBe("max-steps");
  });

  it("does not launch a reserve step with less than three seconds left", async () => {
    const llm = queuedLLM([toolCall("mark", { note: "once" })]);
    const result = await run(llm, { maxSteps: 1, timeoutMs: 2000 });
    expect(result.stop.reason).toBe("max-steps");
    expect(llm.requests).toHaveLength(1);
  });

  it("cannot recover a hook termination that has no accepted candidate", async () => {
    const pipeline = createHookPipeline();
    pipeline.register({
      id: "end",
      event: "PreStep",
      handler: async () => ({
        action: "continue",
        replace: { stop: { reason: "tool-finished" } },
      }),
    });
    const llm = queuedLLM([submit({ answer: 1 })]);
    const result = await run(llm, { hookPipeline: pipeline });
    expect(result.stop.reason).toBe("invalid-output");
    expect(llm.requests).toHaveLength(0);
  });

  it("preserves malformed arguments, original IDs, reasoning and continuation verbatim", async () => {
    const invalid = {
      ...raw('{"answer":'),
      reasoningContent: "private reasoning",
      providerContinuation: {
        protocol: "openai-chat-v1" as const,
        model: "fixture",
        items: [{ type: "reasoning" as const, field: "reasoning" }],
      },
    };
    const llm = queuedLLM([invalid, submit({ answer: 1 })]);
    await run(llm);
    const assistant = llm.requests[1]!.messages.find(
      (message) => message.role === "assistant",
    );
    expect(assistant).toMatchObject({
      toolCalls: invalid.toolCalls,
      reasoningContent: invalid.reasoningContent,
      providerContinuation: invalid.providerContinuation,
    });
  });
});
