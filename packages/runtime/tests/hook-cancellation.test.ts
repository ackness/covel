import { afterEach, describe, expect, it, vi } from "vitest";
import { createHookPipeline } from "../src/hooks/pipeline.js";
import { runPreLLMCallHook } from "../src/hooks/wire-helpers.js";
import type { HookResult } from "../src/hooks/types.js";

afterEach(() => vi.useRealTimers());

describe("hook cancellation", () => {
  it("aborts cooperative work on timeout and ignores a late rewrite", async () => {
    vi.useFakeTimers();
    const pipeline = createHookPipeline();
    const late = Promise.withResolvers<HookResult<{ value: string }>>();
    let signal: AbortSignal | undefined;
    const after = vi.fn();
    pipeline.register({
      id: "slow",
      event: "PreRuntime",
      timeoutMs: 10,
      handler: async (ctx) => {
        signal = ctx.signal;
        return late.promise;
      },
    });
    pipeline.register({ id: "after", event: "PreRuntime", handler: after });
    const result = pipeline.run(
      "PreRuntime",
      { event: "PreRuntime", sessionId: "s1", turnId: "t1" },
      { value: "original" },
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(signal?.aborted).toBe(true);
    expect(await result).toMatchObject({
      action: "abort",
      reason: expect.stringContaining("timed out"),
    });
    late.resolve({ action: "continue", replace: { value: "late" } });
    await Promise.resolve();
    expect(after).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("passes execution cancellation through the real LLM hook wrapper", async () => {
    const pipeline = createHookPipeline();
    const controller = new AbortController();
    const started = Promise.withResolvers<AbortSignal>();
    pipeline.register({
      id: "pending",
      event: "PreLLMCall",
      handler: async (ctx) => {
        started.resolve(ctx.signal!);
        return new Promise(() => {});
      },
    });
    const result = runPreLLMCallHook(
      {
        pipeline,
        signal: controller.signal,
        sessionId: "s1",
        turnId: "t1",
        pluginId: "fixture",
        runtimeId: "fixture/runtime",
      },
      {
        model: undefined,
        tools: undefined,
        messages: [{ role: "user", content: "hello" }],
      },
    );
    const signal = await started.promise;
    controller.abort(new Error("execution cancelled"));
    expect(await result).toEqual({
      model: undefined,
      tools: undefined,
      messages: [{ role: "user", content: "hello" }],
    });
    expect(signal.aborted).toBe(true);
  });

  it("does not start an already cancelled hook and keeps observers non-blocking", async () => {
    const pipeline = createHookPipeline();
    const handler = vi.fn();
    pipeline.register({ id: "observer", event: "TurnStop", handler });
    expect(
      await pipeline.run(
        "TurnStop",
        {
          event: "TurnStop",
          sessionId: "s1",
          turnId: "t1",
          signal: AbortSignal.abort(),
        },
        {},
      ),
    ).toEqual({ action: "continue" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("detaches the parent listener after success", async () => {
    vi.useFakeTimers();
    const pipeline = createHookPipeline();
    const parent = new AbortController();
    const remove = vi.spyOn(parent.signal, "removeEventListener");
    pipeline.register({
      id: "done",
      event: "PreRuntime",
      handler: async () => ({ action: "continue" }),
    });
    await pipeline.run(
      "PreRuntime",
      {
        event: "PreRuntime",
        sessionId: "s1",
        turnId: "t1",
        signal: parent.signal,
      },
      {},
    );
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });
});
