import { describe, expect, it } from "vitest";
import { createEventBus } from "@covel/events";
import { runWithHookScope } from "../src/hooks/hook-scope.js";
import { createHookPipeline } from "../src/hooks/pipeline.js";
import {
  manifest,
  prose,
  queuedLLM,
  runLoop,
  runRuntime,
  toolCall,
  type GenerateParams,
} from "./_helpers/agent-loop-fixture.js";
import type { LLMAdapter, LLMResponse } from "@covel/shared";
import { createTurnEmitter } from "../src/trace/turn-emitter.js";
import type { ReviewAgentOutputPayload } from "../src/hooks/wire-helpers.js";

const submit = (value: Record<string, unknown>, id = "submit") =>
  toolCall("submit-output", value, id);
const malformed = (): LLMResponse => ({
  ...submit({}),
  toolCalls: [{ id: "bad", name: "submit-output", arguments: '{"value":' }],
});
const resultFor = (request: GenerateParams, id: string) =>
  request.messages.find(
    (message) => message.role === "tool" && message.toolCallId === id,
  )?.content;

describe("agent output submission", () => {
  it("repairs complete malformed arguments inside ordinary tool steps", async () => {
    const llm = queuedLLM([malformed(), submit({ value: 2 })]);
    const result = await runLoop({ llm });
    expect(result.acceptedOutput).toEqual({ value: 2 });
    expect(result.stop).toEqual({ reason: "completed" });
    expect(resultFor(llm.requests[1]!, "bad")).toContain("invalid-json");
    expect(llm.requests).toHaveLength(2);
    expect(
      llm.requests.every((request) =>
        request.tools?.some((tool) => tool.name === "submit-output"),
      ),
    ).toBe(true);
  });

  it("rejects valid content JSON without inventing a tool call", async () => {
    const llm = queuedLLM([prose('{"value":1}'), submit({ value: 2 })]);
    const result = await runLoop({ llm });
    expect(result.acceptedOutput).toEqual({ value: 2 });
    expect(
      llm.requests[1]!.messages.some((message) => message.role === "tool"),
    ).toBe(false);
    expect(llm.requests[1]!.messages.at(-1)?.content).toContain(
      "submit-output",
    );
  });

  it("rejects a mixed submission batch before its sibling can write", async () => {
    const batch = submit({});
    const llm = queuedLLM([
      {
        ...batch,
        toolCalls: [
          ...toolCall("mark", { note: "must not run" }, "write").toolCalls,
          ...batch.toolCalls,
        ],
      },
      submit({ ok: true }, "valid"),
    ]);
    const result = await runLoop({ llm });
    expect(result.pendingProposals).toEqual([]);
    expect(result.acceptedOutput).toEqual({ ok: true });
    expect(resultFor(llm.requests[1]!, "write")).toContain("submission-batch");
    expect(resultFor(llm.requests[1]!, "submit")).toContain("submission-batch");
  });

  it("exhausts output repair without spending the review budget or a reserve call", async () => {
    const llm = queuedLLM([malformed(), malformed(), submit({})]);
    const result = await runRuntime({ llm });
    expect(result.status).toBe("failed");
    expect(result.stop?.reason).toBe("invalid-output");
    expect(llm.requests).toHaveLength(2);
    expect(result.pendingProposals).toBeUndefined();
  });

  it("retains business proposals once while repairing a model-authored result", async () => {
    const llm = queuedLLM([
      toolCall("mark", { note: "once" }),
      malformed(),
      submit({
        pluginData: [{ namespace: "injected", key: "bad", value: true }],
        ui: [{ id: "bad" }],
        events: [{ topic: "bad", data: {} }],
        completion: "done",
      }),
    ]);
    const result = await runRuntime({
      llm,
      manifest: manifest({ requireToolUse: true }),
    });
    expect(result.status).toBe("success");
    expect(result.pendingProposals).toHaveLength(1);
    expect(result.effects).toBeUndefined();
    expect(result.output).toEqual({});
    expect(result.completion).toBe("done");
    expect(
      result.toolCalls?.filter((call) => call.toolName === "mark"),
    ).toHaveLength(1);
  });
});

describe("submission hooks and batches", () => {
  it("runs without a business executor or registry", async () => {
    const llm = queuedLLM([submit({})]);
    const result = await runLoop({
      llm,
      manifest: manifest({ tools: undefined }),
      deps: { toolExecutor: undefined },
    });
    expect(result.acceptedOutput).toEqual({});
  });

  it("rejects two submissions and closes both IDs", async () => {
    const llm = queuedLLM([
      {
        ...submit({}),
        toolCalls: [
          ...submit({}, "first").toolCalls,
          ...submit({}, "second").toolCalls,
        ],
      },
      submit({ ok: true }),
    ]);
    const result = await runLoop({ llm });
    expect(result.acceptedOutput).toEqual({ ok: true });
    expect(resultFor(llm.requests[1]!, "first")).toContain("submission-batch");
    expect(resultFor(llm.requests[1]!, "second")).toContain("submission-batch");
  });

  it("prepares rewritten names once before any same-batch write", async () => {
    const pipeline = createHookPipeline();
    const seen: string[] = [];
    pipeline.register<{
      toolCall: { id: string; name: string; arguments: string };
    }>({
      id: "rewrite",
      event: "PreToolUse",
      handler: async (_ctx, payload) => {
        seen.push(payload.toolCall.id);
        return payload.toolCall.id === "rewrite"
          ? {
              action: "continue",
              replace: {
                toolCall: {
                  id: "forged",
                  name: "submit-output",
                  arguments: "{}",
                },
              },
            }
          : { action: "continue" };
      },
    });
    const batch = {
      ...submit({}),
      toolCalls: [
        ...toolCall("mark", { note: "no" }, "write").toolCalls,
        ...toolCall("mark", { note: "no" }, "rewrite").toolCalls,
      ],
    };
    const llm = queuedLLM([batch, submit({}, "valid")]);
    const result = await runLoop({ llm, hookPipeline: pipeline });
    expect(result.pendingProposals).toEqual([]);
    expect(seen).toEqual(["write", "rewrite", "valid"]);
    expect(resultFor(llm.requests[1]!, "rewrite")).toContain(
      "submission-batch",
    );
    expect(
      llm.requests[1]!.messages.find((message) => message.role === "assistant")
        ?.toolCalls,
    ).toEqual(batch.toolCalls);
  });

  it("keeps effective-name authorization after a submission rewrite", async () => {
    const pipeline = createHookPipeline();
    pipeline.register<{
      toolCall: { id: string; name: string; arguments: string };
    }>({
      id: "rewrite",
      event: "PreToolUse",
      handler: async (_ctx, payload) =>
        payload.toolCall.id === "rewrite"
          ? {
              action: "continue",
              replace: {
                toolCall: {
                  ...payload.toolCall,
                  name: "mark",
                  arguments: '{"note":"unauthorized"}',
                },
              },
            }
          : { action: "continue" },
    });
    const llm = queuedLLM([submit({}, "rewrite"), submit({}, "valid")]);
    const result = await runLoop({
      llm,
      manifest: manifest({ tools: undefined }),
      hookPipeline: pipeline,
    });
    expect(result.pendingProposals).toEqual([]);
    expect(resultFor(llm.requests[1]!, "rewrite")).toContain("not declared");
    expect(result.acceptedOutput).toEqual({});
  });

  it("response guards close every original call without dispatch or synthetic review", async () => {
    const pipeline = createHookPipeline();
    let responses = 0;
    let pre = 0;
    pipeline.register({
      id: "guard",
      event: "PostLLMResponse",
      handler: async () =>
        ++responses === 1
          ? {
              action: "continue",
              replace: { correction: "Wrong perspective." },
            }
          : { action: "continue" },
    });
    pipeline.register({
      id: "pre",
      event: "PreToolUse",
      handler: async () => {
        pre++;
        return { action: "continue" };
      },
    });
    const batch = {
      ...toolCall("mark", { note: "no" }),
      toolCalls: [
        ...toolCall("mark", { note: "no" }, "write").toolCalls,
        ...submit({}, "rejected").toolCalls,
      ],
      reasoningContent: "reasoning",
    };
    const llm = queuedLLM([batch, submit({}, "accepted")]);
    const result = await runLoop({ llm, hookPipeline: pipeline });
    expect(result.pendingProposals).toEqual([]);
    expect(responses).toBe(2);
    expect(pre).toBe(1);
    expect(resultFor(llm.requests[1]!, "write")).toContain("review-rejected");
    expect(resultFor(llm.requests[1]!, "rejected")).toContain(
      "review-rejected",
    );
    expect(
      llm.requests[1]!.messages.find((message) => message.role === "assistant")
        ?.reasoningContent,
    ).toBe("reasoning");
  });

  it("cannot forge acceptance or replace a valid candidate through PostToolUse", async () => {
    const pipeline = createHookPipeline();
    let post = 0;
    pipeline.register({
      id: "post",
      event: "PostToolUse",
      handler: async () => {
        post++;
        return {
          action: "continue",
          replace: {
            result: {
              result: "rewritten acknowledgement",
              parsedResult: { forged: true },
              success: true,
              pendingProposals: ["forged"],
            },
          },
        };
      },
    });
    const llm = queuedLLM([malformed(), submit({ actual: true })]);
    const result = await runLoop({ llm, hookPipeline: pipeline });
    expect(post).toBe(2);
    expect(result.acceptedOutput).toEqual({ actual: true });
    expect(result.pendingProposals).toEqual([]);
    expect(result.collectedToolCalls[0]?.output).toMatchObject({
      error: { code: "invalid-json" },
    });
    expect(Object.isFrozen(result.acceptedOutput)).toBe(true);
  });

  it("a terminating PostToolUse hook cannot promote a rejected candidate", async () => {
    const pipeline = createHookPipeline();
    pipeline.register({
      id: "post",
      event: "PostToolUse",
      handler: async () => ({
        action: "continue",
        replace: {
          terminate: true,
          result: { success: true, result: "accepted", parsedResult: {} },
        },
      }),
    });
    const llm = queuedLLM([malformed(), submit({})]);
    const result = await runLoop({ llm, hookPipeline: pipeline });
    expect(result.acceptedOutput).toBeNull();
    expect(result.stop.reason).toBe("invalid-output");
    expect(llm.requests).toHaveLength(1);
  });

  it("reviewers see the validated original candidate and only public tool evidence", async () => {
    const pipeline = createHookPipeline();
    const seen: unknown[] = [];
    pipeline.register<ReviewAgentOutputPayload>({
      id: "mutate",
      event: "ReviewAgentOutput",
      handler: async (_ctx, _payload) => ({
        action: "continue",
        replace: { output: { forged: true }, toolResults: [] },
      }),
    });
    pipeline.register<ReviewAgentOutputPayload>({
      id: "inspect",
      pluginId: "reviewer",
      event: "ReviewAgentOutput",
      handler: async (ctx, payload) => {
        expect(ctx.runtimeId).toBe("plug/loop");
        expect(ctx.pluginId).toBe("plug");
        expect(ctx.getOwnSettings?.()).toEqual({ tone: "owner" });
        expect(payload.output).toEqual({ actual: true });
        expect(payload.toolCall).toEqual({
          id: "original",
          name: "submit-output",
        });
        expect(payload.toolResults).toHaveLength(1);
        expect(payload.toolResults[0]?.output).toEqual({
          _text: "marked:once",
        });
        expect(JSON.stringify(payload)).not.toContain("pendingProposals");
        expect(Object.keys(payload.toolResults[0]!)).toEqual([
          "toolCallId",
          "toolName",
          "output",
        ]);
        seen.push(payload);
        return { action: "continue" };
      },
    });
    const llm = queuedLLM([
      toolCall("mark", { note: "once" }),
      submit({ actual: true }, "original"),
    ]);
    const result = await runWithHookScope(
      {
        activePluginIds: new Set(["plug", "reviewer"]),
        settings: { reviewer: { tone: "owner" }, plug: { tone: "subject" } },
      },
      () => runLoop({ llm, hookPipeline: pipeline }),
    );
    expect(result.acceptedOutput).toEqual({ actual: true });
    expect(seen).toHaveLength(1);
  });

  it("a broken reviewer fails closed without spending a model correction", async () => {
    const pipeline = createHookPipeline();
    let post = 0;
    pipeline.register({
      id: "post",
      event: "PostToolUse",
      handler: async () => {
        post++;
        return { action: "continue" };
      },
    });
    pipeline.register({
      id: "broken",
      event: "ReviewAgentOutput",
      handler: async () => {
        throw new Error("private reviewer failure");
      },
    });
    const llm = queuedLLM([submit({})]);
    await expect(runLoop({ llm, hookPipeline: pipeline })).rejects.toThrow(
      "Agent output review aborted",
    );
    expect(llm.requests).toHaveLength(1);
    expect(post).toBe(1);
  });
});

describe("submission terminal boundaries", () => {
  it("does not accept a complete tool block from a refused provider response", async () => {
    const llm: LLMAdapter = {
      generate: async () => ({ ...submit({}), finishReason: "content_filter" }),
      stream: async function* () {
        yield { type: "tool-call" as const, ...submit({}).toolCalls[0]! };
        yield { type: "done" as const, finishReason: "content_filter" };
      },
    };
    const result = await runRuntime({ llm });
    expect(result.status).toBe("failed");
    expect(result.stop?.reason).toBe("model-error");
    expect(result.output).toBeNull();
  });

  it("a cancellation during output review beats candidate success", async () => {
    const controller = new AbortController();
    const pipeline = createHookPipeline();
    pipeline.register({
      id: "cancel",
      event: "ReviewAgentOutput",
      handler: async () => {
        controller.abort();
        return { action: "continue" };
      },
    });
    const llm = queuedLLM([submit({ valid: true })]);
    const result = await runRuntime({
      llm,
      deps: {
        hookPipeline: pipeline,
        turnControl: { signal: controller.signal },
      },
    });
    expect(result.status).toBe("failed");
    expect(result.output).toBeNull();
    expect(llm.requests).toHaveLength(1);
  });

  it("defensively rejects an invalid PostRuntime rewrite with no additional model call", async () => {
    const pipeline = createHookPipeline();
    pipeline.register<{ result: import("@covel/shared").RuntimeResult }>({
      id: "rewrite",
      event: "PostRuntime",
      handler: async (_ctx, payload) => ({
        action: "continue",
        replace: {
          result: { ...payload.result, output: { narrativeOutput: "" } },
        },
      }),
    });
    const llm = queuedLLM([submit({ narrativeOutput: "A valid story." })]);
    const result = await runRuntime({
      llm,
      manifest: manifest({ outputKind: "story" }),
      deps: { hookPipeline: pipeline },
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("output-schema-invalid");
    expect(result.output).toBeNull();
    expect(llm.requests).toHaveLength(1);
  });

  it("does not let a later reviewer erase an earlier correction", async () => {
    const pipeline = createHookPipeline();
    pipeline.register<ReviewAgentOutputPayload>({
      id: "first",
      event: "ReviewAgentOutput",
      handler: async () => ({
        action: "continue",
        replace: { correction: "Please revise." },
      }),
    });
    pipeline.register<ReviewAgentOutputPayload>({
      id: "second",
      event: "ReviewAgentOutput",
      handler: async () => ({
        action: "continue",
        replace: { correction: "", output: { forged: true } },
      }),
    });
    const llm = queuedLLM([submit({})]);
    const result = await runLoop({ llm, hookPipeline: pipeline });
    expect(result.stop.reason).toBe("invalid-output");
    expect(result.acceptedOutput).toBeNull();
    expect(llm.requests).toHaveLength(3);
  });
});

it("redacts concealed submission arguments and review text while retaining safe rejection status", async () => {
  const events: { type: string; payload: unknown }[] = [];
  const runtime = manifest({ concealed: true });
  const emitter = createTurnEmitter({
    sessionId: "sess-loop",
    turnId: "turn-loop",
    concealedRuntimeIds: new Set([runtime.name]),
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
    manifest: runtime,
    llm: queuedLLM([submit({ secret: "PRIVATE_CANDIDATE" })]),
    deps: { emitter, hookPipeline: pipeline },
  });
  const projected = JSON.stringify(events);
  expect(projected).not.toContain("PRIVATE_REVIEW");
  expect(projected).not.toContain("PRIVATE_CANDIDATE");
  expect(projected).toContain("output-rejected");
  expect(result.error).not.toContain("PRIVATE_");
  expect(result.status).toBe("failed");
});

it.each(["throw", "abort"] as const)(
  "keeps private reviewer %s details out of hook events and final errors",
  async (mode) => {
    const bus = createEventBus();
    const events: unknown[] = [];
    bus.onEmit((event) => events.push(event));
    const pipeline = createHookPipeline();
    pipeline.register({
      id: "review",
      event: "ReviewAgentOutput",
      handler: async () => {
        if (mode === "throw") throw new Error("PRIVATE_REVIEW_FAILURE");
        return { action: "abort", reason: "PRIVATE_REVIEW_FAILURE" };
      },
    });
    try {
      const result = await runRuntime({
        manifest: manifest({ concealed: true }),
        llm: queuedLLM([submit({ secret: "PRIVATE_CANDIDATE" })]),
        deps: { eventBus: bus, hookPipeline: pipeline },
      });
      expect(result.status).toBe("failed");
      expect(result.error).not.toContain("PRIVATE_");
      expect(JSON.stringify(events)).not.toContain("PRIVATE_");
      expect(JSON.stringify(events)).toContain(
        "Agent output review did not accept the submission.",
      );
    } finally {
      await bus.close();
    }
  },
);

describe("submission business value checks", () => {
  it("rejects contradictory completion fields as a correctable submission", async () => {
    for (const [conflict, fixed] of [
      [{ preGameDone: false, completion: "done" }, { preGameDone: false }],
      [{ preGameDone: true, completion: "pending" }, { preGameDone: true }],
    ] as const) {
      const llm = queuedLLM([submit(conflict, "conflict"), submit(fixed)]);
      const result = await runLoop({ llm });
      expect(result.acceptedOutput).toEqual(fixed);
      expect(llm.requests).toHaveLength(2);
      expect(resultFor(llm.requests[1]!, "conflict")).toContain(
        "contradict each other",
      );
    }
  });

  it("keeps a waiting setup pending and still lets a consistent submission finish", async () => {
    for (const [value, completion] of [
      [{ preGameDone: false }, undefined],
      [{ preGameDone: false, completion: "pending" }, "pending"],
      [{ preGameDone: true }, "done"],
      [{ completion: "done" }, "done"],
      [{ preGameDone: true, completion: "done" }, "done"],
    ] as const) {
      const result = await runRuntime({ llm: queuedLLM([submit(value)]) });
      expect(result.status, JSON.stringify(value)).toBe("success");
      expect(result.completion, JSON.stringify(value)).toBe(completion);
      expect(result.output).toEqual({});
    }
  });

  it("checks the public contract before review and asks for a corrected candidate", async () => {
    const pipeline = createHookPipeline();
    const reviewed: unknown[] = [];
    pipeline.register<ReviewAgentOutputPayload>({
      id: "review",
      event: "ReviewAgentOutput",
      handler: async (_ctx, payload) => {
        reviewed.push(payload.output);
        return { action: "continue" };
      },
    });
    const runtime = manifest({ outputContract: "example.value@1" });
    const llm = queuedLLM([
      submit({ completion: "done" }, "missing"),
      submit({ value: 1, completion: "done" }),
    ]);
    const result = await runLoop({
      llm,
      manifest: runtime,
      hookPipeline: pipeline,
      loaded: {
        manifest: runtime,
        promptTemplate: "prompt",
        outputSchema: {
          type: "object",
          properties: {
            value: { type: "number" },
            completion: { type: "string", enum: ["done", "pending"] },
          },
        },
        // Protocol fields are not part of the business value the contract sees.
        outputContractSchema: {
          type: "object",
          properties: { value: { type: "number" } },
          required: ["value"],
          additionalProperties: false,
        },
      },
    });
    expect(result.acceptedOutput).toEqual({ value: 1, completion: "done" });
    expect(llm.requests).toHaveLength(2);
    expect(resultFor(llm.requests[1]!, "missing")).toContain(
      "example.value@1",
    );
    expect(reviewed).toEqual([{ value: 1, completion: "done" }]);
  });
});
