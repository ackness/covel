import { afterEach, describe, expect, it, vi } from "vitest";
import type { LLMAdapter } from "@covel/shared";
import { tool } from "@covel/tools";
import { z } from "zod";
import { ContextOverflowError } from "../src/agent-loop/request-context-budget.js";
import { settleAgentLoop } from "../src/agent-loop/settle-agent-loop.js";
import { stopOf } from "../src/agent-loop/stop-reason.js";
import { formatToolLoopFailure } from "../src/turn-executor/turn-output-helpers.js";
import { createHookPipeline } from "../src/hooks/pipeline.js";
import type { PreLLMCallRequest } from "../src/hooks/wire-helpers.js";
import { makeEmitterSpy } from "./_helpers/emitter-spy.js";
import {
  input,
  manifest,
  makeExecutor,
  prose,
  queuedLLM,
  runLoop,
  runRuntime,
  scriptedLLM,
  toolCall,
} from "./_helpers/agent-loop-fixture.js";

const small = {
  estimator: (text: string) => text.length,
  contextBudget: { maxInputTokens: 1_000, reservedForResponse: 100 },
};
const largeCall = () => toolCall("mark", { note: "x".repeat(3_000) });
function settle(
  loop: Awaited<ReturnType<typeof runLoop>>,
  runtime = manifest(),
  outputSchema?: Record<string, unknown>,
) {
  return settleAgentLoop({
    manifest: runtime,
    input,
    runId: "run-loop",
    startTime: Date.now(),
    toolLoop: loop,
    outputSchema,
  });
}
function identity(llm: LLMAdapter): LLMAdapter {
  return {
    ...llm,
    resolveTarget: () => ({ provider: "fixture", model: "small" }),
  };
}
afterEach(() => vi.restoreAllMocks());

describe("context overflow in the agent loop", () => {
  it("condenses a long tool conversation while preserving full runtime tool results and the canonical transcript", async () => {
    const read = tool({
      name: "read",
      description: "Read data",
      parameters: z.object({ page: z.number() }),
      execute: async ({ page }) => ({
        _text: `page ${page}`,
        body: "r".repeat(1_200),
      }),
    });
    const llm = scriptedLLM((_request, call) =>
      call <= 8
        ? toolCall("read", { page: call }, `read-${call}`)
        : prose("done"),
    );
    const emitter = makeEmitterSpy();
    const messages: import("@covel/shared").LLMMessage[] = [
      { role: "system" as const, content: "sys" },
      { role: "user" as const, content: "go" },
    ];
    const runtime = manifest({ tools: { plugin: ["read"] } });
    const loop = await runLoop({
      llm,
      manifest: runtime,
      messages,
      maxSteps: 10,
      deps: { emitter, toolExecutor: makeExecutor([read]) },
      estimator: small.estimator,
      contextBudget: { maxInputTokens: 6_000, reservedForResponse: 100 },
    });
    const { result } = settle(loop, runtime);
    expect(result.status).toBe("success");
    expect(result.toolCalls).toHaveLength(8);
    for (const call of result.toolCalls)
      expect(JSON.stringify(call.output)).toContain("r".repeat(1_200));
    expect(
      llm.requests.some((request) =>
        request.messages.some((message) =>
          String(message.content).includes("[older tool output omitted]"),
        ),
      ),
    ).toBe(true);
    const events = emitter.events.filter(
      (event) => event.type === "context.pruned",
    );
    expect(
      events.some((event) => Number(event.payload.elidedToolResultCount) > 0),
    ).toBe(true);
    expect(
      events.every(
        (event) => typeof event.payload.collapsedStepCount === "number",
      ),
    ).toBe(true);
    expect(messages.filter((message) => message.role === "tool")).toHaveLength(
      8,
    );
    expect(JSON.stringify(messages)).not.toContain(
      "[older tool output omitted]",
    );
    expect(JSON.stringify(messages)).toContain("r".repeat(1_200));
  });

  it("returns an unrescuable stop with all collected calls and settles the original identity-prefixed text verbatim", async () => {
    const llm = queuedLLM([largeCall()]);
    const emitter = makeEmitterSpy();
    const runtime = manifest({
      loopProfile: { finalizer: { maxSteps: false } },
    });
    const loop = await runLoop({
      llm: identity(llm),
      manifest: runtime,
      deps: { emitter },
      ...small,
    });
    expect(loop.stop).toEqual({ reason: "context-overflow" });
    expect(loop.stopMessage).toMatch(
      /^\[provider: fixture, model: small, slot: default\] Context budget exceeded/,
    );
    const { result } = settle(loop, runtime);
    expect(result.status).toBe("failed");
    expect(result.error).toBe(loop.stopMessage);
    expect(result.error?.match(/\[provider:/g)).toHaveLength(1);
    expect(result.toolCalls).toHaveLength(1);
    expect(llm.requests).toHaveLength(1);
    const completed = emitter.events.filter(
      (event) => event.type === "step.completed",
    );
    expect(completed[1]?.payload).toMatchObject({
      step: 2,
      stopReason: "context-overflow",
    });
    expect(completed[1]?.payload).not.toHaveProperty("usage");
  });

  it("rescues an oversized newest call once with tools off, closes its step, and returns success", async () => {
    const llm = queuedLLM([largeCall(), prose("rescued answer")]);
    const emitter = makeEmitterSpy();
    const loop = await runLoop({ llm, deps: { emitter }, ...small });
    expect(loop.stop).toEqual({ reason: "context-overflow", finalizer: true });
    expect(loop.stopMessage).toBeUndefined();
    expect(loop.finalContent).toBe("rescued answer");
    expect(settle(loop).result.status).toBe("success");
    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[1]?.tools).toBeUndefined();
    expect(
      llm.requests[1]?.messages.some((message) => message.role === "tool"),
    ).toBe(false);
    const steps = emitter.events.filter((event) =>
      event.type.startsWith("step."),
    );
    expect(steps.map((event) => [event.type, event.payload.step])).toEqual([
      ["step.started", 1],
      ["step.completed", 1],
      ["step.started", 2],
      ["step.completed", 2],
      ["step.started", 3],
      ["step.completed", 3],
    ]);
    expect(steps[3]?.payload).toMatchObject({ stopReason: "context-overflow" });
    expect(steps[3]?.payload).not.toHaveProperty("usage");
    expect(steps[4]?.payload).toMatchObject({
      step: 3,
      finalizer: true,
      toolCount: 0,
    });
    expect(
      emitter.events.find((event) => event.type === "context.pruned")?.payload,
    ).toMatchObject({ collapsedStepCount: 1 });
  });

  it("allows output repair after an overflow finalizer, with its collapsed ledger replayed", async () => {
    const llm = queuedLLM([
      largeCall(),
      prose("invalid answer"),
      prose('{"answer":"fixed"}'),
    ]);
    const outputSchema = {
      type: "object",
      required: ["answer"],
      properties: { answer: { type: "string" } },
    };
    const runtime = manifest();
    const loop = await runLoop({
      llm,
      loaded: { manifest: runtime, promptTemplate: "JSON", outputSchema },
      ...small,
      contextBudget: { maxInputTokens: 1_800, reservedForResponse: 100 },
    });
    expect(loop.stop).toEqual({
      reason: "context-overflow",
      finalizer: true,
      repaired: true,
    });
    expect(settle(loop, runtime, outputSchema).result.output).toEqual({
      answer: "fixed",
    });
    expect(llm.requests).toHaveLength(3);
    expect(llm.requests[2]?.tools).toBeUndefined();
    expect(
      llm.requests[2]?.messages.some((message) => message.role === "tool"),
    ).toBe(false);
  });

  it.each(["empty", "overflow", "rejected", "provider error"])(
    "preserves the first overflow when its finalizer is %s",
    async (failure) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const hookPipeline = createHookPipeline();
      let hooks = 0;
      const prompts: string[] = [];
      hookPipeline.register<PreLLMCallRequest>({
        id: "budget-fixture",
        event: "PreLLMCall",
        handler: async (_ctx, payload) => {
          hooks += 1;
          prompts.push(JSON.stringify(payload.messages));
          return failure === "overflow" && hooks === 3
            ? {
                action: "continue",
                replace: {
                  messages: [
                    { role: "system", content: "fixed".repeat(1_000) },
                    ...payload.messages.slice(1),
                  ],
                },
              }
            : { action: "continue" };
        },
      });
      if (failure === "rejected")
        hookPipeline.register({
          id: "reject",
          event: "PostLLMResponse",
          handler: async () =>
            hooks >= 3
              ? { action: "continue", replace: { correction: "Try again" } }
              : { action: "continue" },
        });
      const llm = scriptedLLM((_params, call) => {
        if (call === 1) return largeCall();
        if (failure === "provider error") throw new Error("unavailable");
        return prose(failure === "empty" ? "" : "draft");
      });
      const loop = await runLoop({
        llm: identity(llm),
        hookPipeline,
        ...small,
      });
      expect(loop.stop).toEqual({ reason: "context-overflow" });
      expect(loop.stopMessage).toContain("tools=");
      expect(loop.stopMessage).not.toContain("fixed=5000");
      expect(settle(loop).result.error).toBe(loop.stopMessage);
      expect(hooks).toBe(3);
      expect(llm.requests).toHaveLength(failure === "overflow" ? 1 : 2);
    },
  );

  it.each(["required work", "explicit completion", "no time"])(
    "does not rescue when the finalizer lacks %s",
    async (reason) => {
      const now = Date.now();
      if (reason === "no time") vi.spyOn(Date, "now").mockReturnValue(now);
      const llm = scriptedLLM(() => {
        if (reason === "no time")
          vi.mocked(Date.now).mockReturnValue(now + 7_500);
        return reason === "required work"
          ? toolCall("mark", { wrong: "x".repeat(3_000) })
          : largeCall();
      });
      const runtime = manifest({
        ...(reason === "required work" ? { requireToolUse: true } : {}),
        ...(reason === "explicit completion"
          ? { requireExplicitCompletion: true }
          : {}),
      });
      const loop = await runLoop({ llm, manifest: runtime, ...small });
      expect(loop.stop).toEqual({ reason: "context-overflow" });
      expect(settle(loop, runtime).result.status).toBe("failed");
      expect(llm.requests).toHaveLength(1);
    },
  );

  it("does not request a finalizer before any complete tool step exists", async () => {
    const llm = queuedLLM([prose("unreached")]);
    const loop = await runLoop({
      llm,
      messages: [
        { role: "system", content: "s".repeat(2_000) },
        { role: "user", content: "go" },
      ],
      ...small,
    });
    expect(loop.stop).toEqual({ reason: "context-overflow" });
    expect(llm.requests).toHaveLength(0);
    expect(settle(loop).result.status).toBe("failed");
  });

  it("keeps invalid limits thrown and tagged without offering a finalizer", async () => {
    const llm = queuedLLM([prose("unreached")]);
    let caught: unknown;
    try {
      await runLoop({
        ...small,
        llm: {
          ...llm,
          resolveBudget: () => ({
            contextWindow: 100,
            requestedMaxOutputTokens: 100,
          }),
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ContextOverflowError);
    expect(caught).toMatchObject({ kind: "invalid-limits" });
    expect(stopOf(caught, "run-loop")).toEqual({ reason: "context-overflow" });
    expect(llm.requests).toHaveLength(0);
  });

  it("retains the runtime fault on unfinished overflow through runtime finalization", async () => {
    const hookPipeline = createHookPipeline();
    hookPipeline.register<PreLLMCallRequest>({
      id: "request-size",
      event: "PreLLMCall",
      handler: async (_ctx, payload) => ({
        action: "continue",
        replace: {
          messages: [
            { role: "system", content: "s".repeat(30_000) },
            ...payload.messages.slice(1),
          ],
        },
      }),
    });
    const result = await runRuntime({
      llm: identity(queuedLLM([prose("unreached")])),
      deps: {
        hookPipeline,
        estimator: small.estimator,
        contextBudget: { maxInputTokens: 20_000, reservedForResponse: 100 },
      },
    });
    expect(result.stop).toEqual({ reason: "context-overflow" });
    expect(result.status).toBe("failed");
    expect(result.fault).toBe("runtime");
    expect(result.error).toMatch(/^\[provider: fixture/);
  });

  it("preserves calls and the original overflow when fixed input also blocks its finalizer", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const hookPipeline = createHookPipeline();
    let calls = 0;
    hookPipeline.register<PreLLMCallRequest>({
      id: "fixed-input",
      event: "PreLLMCall",
      handler: async (_ctx, payload) => ({
        action: "continue",
        replace: {
          messages: [
            {
              role: "system",
              content: ++calls === 1 ? "sys" : "s".repeat(2_000),
            },
            ...payload.messages.slice(1),
          ],
        },
      }),
    });
    const llm = queuedLLM([toolCall("mark", { note: "work" })]);
    const loop = await runLoop({ llm: identity(llm), hookPipeline, ...small });
    expect(loop.stop).toEqual({ reason: "context-overflow" });
    expect(loop.stopMessage).toContain("system=2000");
    expect(settle(loop).result.error).toBe(loop.stopMessage);
    expect(loop.collectedToolCalls).toHaveLength(1);
    expect(calls).toBe(3);
    expect(llm.requests).toHaveLength(1);
  });

  it("returns a rescued runtime through finalization without a fault", async () => {
    const hookPipeline = createHookPipeline();
    hookPipeline.register<PreLLMCallRequest>({
      id: "compact-request",
      event: "PreLLMCall",
      handler: async (_ctx, payload) => ({
        action: "continue",
        replace: {
          messages: payload.messages.map((message) =>
            message.role === "system"
              ? { ...message, content: "sys" }
              : message.role === "user"
                ? { ...message, content: "go" }
                : message,
          ),
        },
      }),
    });
    const llm = queuedLLM([largeCall(), prose('{"answer":"rescued"}')]);
    const result = await runRuntime({
      llm: {
        ...identity(llm),
        resolveBudget: () => ({
          contextWindow: 1_000,
          requestedMaxOutputTokens: 100,
        }),
      },
      deps: {
        hookPipeline,
        estimator: small.estimator,
        contextBudget: { maxInputTokens: 20_000, reservedForResponse: 100 },
      },
    });
    expect(result.status).toBe("success");
    expect(result.stop).toEqual({
      reason: "context-overflow",
      finalizer: true,
    });
    expect(result.output).toEqual({ answer: "rescued" });
    expect(result.fault).toBeUndefined();
    expect(result.toolCalls).toHaveLength(1);
  });

  it("formats overflow messages verbatim and supplies a fallback without a message", () => {
    const args = {
      runtimeId: "plug/loop",
      reason: "context_overflow" as const,
      failedToolCalls: [],
    };
    expect(
      formatToolLoopFailure({ ...args, message: "original overflow" }),
    ).toBe("original overflow");
    expect(formatToolLoopFailure(args)).toBe(
      'Runtime "plug/loop" stopped because the request no longer fits the model\'s context window.',
    );
  });
});
