import { AiProviderError } from "@covel/ai-provider";
import { callLLMWithRetry } from "../src/retry/llm-retry.js";
import { buildRetryPolicy } from "../src/retry/retry-common.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  acquireLLMSlot,
  createLlmRequestBudget,
  setLLMSlotCapForTests,
} from "@covel/shared";
import { createPluginRuntimeGateway } from "../src/function-runtime/plugin-runtime-gateway.js";
import { createGatewayAdapter } from "../src/llm/gateway-llm-adapter.js";
import { modelGateway } from "./helpers/model-gateway.js";

beforeEach(() => {
  vi.useFakeTimers();
  setLLMSlotCapForTests(1);
});
afterEach(() => {
  setLLMSlotCapForTests(undefined);
  vi.useRealTimers();
});
async function consume(source: AsyncIterable<unknown>) {
  for await (const _event of source) {
    /* drain */
  }
}

it("shares one FIFO text cap across direct, function, and agent calls, including streams, objects and evaluations", async () => {
  let active = 0;
  let peak = 0;
  const modes: string[] = [];
  const releases: Array<() => void> = [];
  const run = async (_config: unknown, mode: string) => {
    modes.push(mode);
    active++;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) => releases.push(resolve));
    active--;
  };
  const full = modelGateway(run);
  const other = modelGateway(run);
  const fn = createPluginRuntimeGateway(full, {
    toZodSchema: () => z.object({ ok: z.boolean() }),
  });
  const agent = createGatewayAdapter(other);
  const messages = [{ role: "user" as const, content: "hello" }];
  const calls = [
    full.generateText({ messages }),
    fn.generateText({ prompt: "hello" }),
    fn.generateObject({ schema: {}, prompt: "hello" }),
    fn.evaluate!({ presetId: "fixture", state: {}, questions: {} }),
    agent.generate({ messages }),
    consume(agent.stream!({ messages })),
    other.generateObject({ messages, schema: z.object({ ok: z.boolean() }) }),
    other.evaluate({ presetId: "fixture", state: {}, questions: {} }),
    consume(full.streamText({ messages })),
  ];
  const all = Promise.all(calls);
  for (let index = 0; index < calls.length; index++) {
    await vi.advanceTimersByTimeAsync(1);
    expect(modes).toHaveLength(index + 1);
    expect(active).toBe(1);
    releases[index]!();
  }
  await all;
  expect(peak).toBe(1);
  expect(modes).toEqual([
    "text",
    "text",
    "object",
    "evaluate",
    "text",
    "stream",
    "object",
    "evaluate",
    "stream",
  ]);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([false, true])(
  "expires queued direct calls without reaching the wire (stream=%s)",
  async (stream) => {
    const holder = await acquireLLMSlot();
    const run = vi.fn();
    const full = modelGateway(run);
    const options = {
      requestBudget: createLlmRequestBudget({ timeoutMs: 100 }),
    };
    const input = { messages: [] };
    const pending = stream
      ? consume(full.streamText(input, options))
      : full.generateText(input, options);
    const rejected = expect(pending).rejects.toMatchObject({
      code: "REQUEST_BUDGET_EXCEEDED",
    });
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(run).not.toHaveBeenCalled();
    holder.release();
    await full.generateText(input);
    expect(run).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("holds a stream's slot through consumption and releases it on consumer return", async () => {
  const full = modelGateway(async () => {});
  const iterator = full.streamText({ messages: [] })[Symbol.asyncIterator]();
  expect((await iterator.next()).value).toMatchObject({ type: "text-delta" });
  let started = false;
  const queued = modelGateway(async () => {
    started = true;
  }).generateText({ messages: [] });
  await vi.advanceTimersByTimeAsync(1);
  expect(started).toBe(false);
  await iterator.return?.();
  await queued;
  expect(started).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("pauses a non-streaming attempt during fallback queuing without resetting time already spent", async () => {
  let calls = 0;
  const full = modelGateway(async () => {
    calls++;
    if (calls === 1) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      throw new AiProviderError({
        code: "PROVIDER_ERROR",
        provider: "fixture",
        message: "temporary failure",
        retriable: true,
      });
    }
    await new Promise(() => {});
  }, true);
  const onQueueWait = vi.fn();
  const pending = callLLMWithRetry({
    llm: createGatewayAdapter(full),
    messages: [],
    policy: buildRetryPolicy({
      runtimeTimeoutMs: 300,
      callTimeoutMs: 50,
      maxRetries: 0,
    }),
    deadline: Date.now() + 300,
    onQueueWait,
  });
  const rejected = expect(pending).rejects.toMatchObject({
    reason: "call-timeout",
  });
  await vi.advanceTimersByTimeAsync(0);
  const nextSlot = acquireLLMSlot();
  await vi.advanceTimersByTimeAsync(40);
  const holder = await nextSlot;
  await vi.advanceTimersByTimeAsync(100);
  holder.release();
  await vi.advanceTimersByTimeAsync(9);
  expect(calls).toBe(2);
  expect(onQueueWait).toHaveBeenCalledWith(100);
  let settled = false;
  void pending.catch(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
  (await acquireLLMSlot()).release();
});
