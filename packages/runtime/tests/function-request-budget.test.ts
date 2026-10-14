import { AiProviderError } from "@covel/ai-provider";
import type { RuntimeManifest } from "@covel/shared";
import { executeTurn } from "../src/turn-executor/turn-executor.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import type { LLMRequestBudget } from "@covel/shared";
import { createPluginRuntimeGateway } from "../src/function-runtime/plugin-runtime-gateway.js";
import {
  withDefaultGatewaySignal,
  withStalledCallRetry,
} from "../src/function-runtime/runtime-abort-boundaries.js";
import { modelGateway } from "./helpers/model-gateway.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setup(timeoutMs: number, delay: (attempt: number) => number) {
  const budgets: LLMRequestBudget[] = [];
  const runtime = new AbortController();
  const deadline = Date.now() + timeoutMs;
  const full = modelGateway(async (config) => {
    budgets.push(config.requestBudget!);
    // Deliberately uncooperative: the gateway must ignore late completion.
    await new Promise<void>((resolve) =>
      setTimeout(resolve, delay(budgets.length)),
    );
  });
  const gateway = withStalledCallRetry(
    withDefaultGatewaySignal(
      createPluginRuntimeGateway(full, {
        toZodSchema: () => z.object({ ok: z.boolean() }),
      }),
      runtime.signal,
    ),
    { deadline, runtimeId: "fixture/function" },
  );
  return { gateway, budgets, runtime, deadline };
}

it.each([60_000, 120_000, 240_000, 300_000])(
  "uses the remaining %i ms instead of the default gateway ceiling",
  async (remaining) => {
    const answer =
      remaining === 300_000 ? 130_000 : Math.min(55_000, remaining - 1);
    const { gateway, budgets, deadline } = setup(remaining, () => answer);
    const pending = gateway.generateText({ prompt: "hello" });
    await vi.advanceTimersByTimeAsync(answer);
    expect((await pending).text).toBe("ok");
    expect(budgets).toHaveLength(1);
    expect(budgets[0]).toMatchObject({
      deadline,
      ceiling: deadline,
      attempts: 1,
    });
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each(["object", "evaluate"] as const)(
  "passes the host deadline to %s",
  async (kind) => {
    const { gateway, budgets, deadline } = setup(300_000, () => 130_000);
    const pending =
      kind === "object"
        ? gateway.generateObject({ schema: {}, prompt: "hello" })
        : gateway.evaluate!({ presetId: "fixture", state: {}, questions: {} });
    await vi.advanceTimersByTimeAsync(130_000);
    await pending;
    expect(budgets[0]?.deadline).toBe(deadline);
    expect(budgets).toHaveLength(1);
  },
);

it("shares one transport allowance across a stalled retry and ignores the late first result", async () => {
  const { gateway, budgets, deadline } = setup(300_000, (attempt) =>
    attempt === 1 ? 280_000 : 1_000,
  );
  const pending = gateway.generateText({ prompt: "hello" });
  await vi.advanceTimersByTimeAsync(151_000);
  expect((await pending).text).toBe("ok");
  expect(budgets).toHaveLength(2);
  expect(budgets[1]).toBe(budgets[0]);
  expect(budgets[0]).toMatchObject({ deadline, attempts: 2 });
  await vi.advanceTimersByTimeAsync(129_000);
  expect(vi.getTimerCount()).toBe(0);
});

it("creates a fresh budget for each logical call, using the same runtime deadline", async () => {
  const { gateway, budgets, deadline } = setup(300_000, () => 1000);
  const first = gateway.generateText({ prompt: "first" });
  await vi.advanceTimersByTimeAsync(1000);
  await first;
  await vi.advanceTimersByTimeAsync(240_000);
  const second = gateway.generateText({ prompt: "second" });
  await vi.advanceTimersByTimeAsync(1000);
  await second;
  expect(budgets[1]).not.toBe(budgets[0]);
  expect(budgets.map((budget) => budget.deadline)).toEqual([
    deadline,
    deadline,
  ]);
  expect(budgets.map((budget) => budget.attempts)).toEqual([1, 1]);
});

it("stops at the runtime deadline and does not retry a player abort", async () => {
  const timed = setup(60_000, () => 90_000);
  const pending = timed.gateway.generateText({ prompt: "hello" });
  const rejected = expect(pending).rejects.toMatchObject({
    code: "REQUEST_BUDGET_EXCEEDED",
  });
  await vi.advanceTimersByTimeAsync(60_000);
  await rejected;
  expect(timed.budgets).toHaveLength(1);
  const cancelled = setup(300_000, () => 200_000);
  const call = cancelled.gateway.generateText({ prompt: "cancel" });
  const stopped = expect(call).rejects.toThrow("player stopped");
  await vi.advanceTimersByTimeAsync(1);
  cancelled.runtime.abort(new Error("player stopped"));
  await stopped;
  await vi.advanceTimersByTimeAsync(300_000);
  expect(cancelled.budgets).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("carries the host budget through the actual function executor", async () => {
  const budgets: LLMRequestBudget[] = [];
  const started = Date.now();
  const manifest: RuntimeManifest = {
    name: "fixture/function",
    pluginId: "fixture",
    description: "Fixture",
    runtimeType: "function",
    stage: "narrative",
    trigger: { type: "auto" },
    timeoutMs: 300_000,
  };
  const pending = executeTurn(
    {
      origin: "player",
      sessionId: "session",
      turnId: "turn",
      playerMessage: "hello",
    },
    [manifest],
    {
      llm: { generate: vi.fn() },
      gateway: createPluginRuntimeGateway(
        modelGateway(async (config) => {
          budgets.push(config.requestBudget!);
          await new Promise((resolve) => setTimeout(resolve, 130_000));
        }),
      ),
      loadRuntime: async () => ({
        manifest,
        promptTemplate: "",
        handler: async (ctx) => {
          const result = await ctx.gateway!.generateText({ prompt: "hello" });
          return { outcome: "success", value: result.text };
        },
      }),
    },
  );
  await vi.advanceTimersByTimeAsync(130_000);
  const result = await pending;
  expect(result.runtimeResults[0]).toMatchObject({
    status: "success",
    output: { value: "ok" },
  });
  expect(budgets[0]?.deadline).toBe(started + 300_000);
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps the function budget and transport count when switching fallback targets", async () => {
  const budgets: LLMRequestBudget[] = [];
  const gateway = withStalledCallRetry(
    createPluginRuntimeGateway(
      modelGateway(async (config) => {
        budgets.push(config.requestBudget!);
        if (budgets.length === 1)
          throw new AiProviderError({
            code: "PROVIDER_ERROR",
            message: "temporary failure",
            provider: "fixture",
            retriable: true,
          });
        await new Promise((resolve) => setTimeout(resolve, 130_000));
      }, true),
    ),
    { deadline: Date.now() + 300_000, runtimeId: "fixture/function" },
  );
  const pending = gateway.generateText({ prompt: "hello" });
  await vi.advanceTimersByTimeAsync(130_000);
  expect((await pending).text).toBe("ok");
  expect(budgets).toHaveLength(2);
  expect(budgets[1]).toBe(budgets[0]);
  expect(budgets[0]?.attempts).toBe(2);
});
