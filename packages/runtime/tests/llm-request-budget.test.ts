import {
  AiProviderError,
  createGateway,
  createPresetRegistry,
  createProviderRegistry,
} from "@covel/ai-provider";
import {
  createLlmRequestBudget,
  type LLMAdapter,
  type LLMProviderRequest,
} from "@covel/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGatewayAdapter } from "../src/llm/gateway-llm-adapter.js";
import {
  buildRetryPolicy,
  callLLMWithRetry,
  streamLLMWithRetry,
} from "../src/retry/llm-retry.js";
import {
  requestLLMResponse,
  type RequestLLMResponseOptions,
} from "../src/agent-loop/tool-loop-handler.js";
import { TurnAbortedError } from "../src/turn-executor/turn-control.js";
import {
  acquireLLMSlot,
  setLLMSlotCapForTests,
} from "../src/retry/llm-slots.js";

const messages = [{ role: "user" as const, content: "Hello" }];
const policy = buildRetryPolicy({ runtimeTimeoutMs: 120_000, maxRetries: 3 });
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("agent request recovery budgets", () => {
  function request(
    llm: LLMAdapter,
    useStreaming = true,
    extraDeps: Omit<RequestLLMResponseOptions["deps"], "llm"> = {},
  ) {
    return requestLLMResponse({
      manifest: {
        name: "fixture/story",
        pluginId: "fixture",
        description: "Fixture",
      },
      deps: { llm, ...extraDeps },
      messages,
      effectiveModel: undefined,
      toolDefs: useStreaming
        ? undefined
        : [
            {
              type: "function",
              function: {
                name: "fixture",
                description: "Fixture",
                parameters: { type: "object" },
              },
            },
          ],
      responseFormat: undefined,
      retryPolicy: buildRetryPolicy({
        runtimeTimeoutMs: 120_000,
        maxRetries: 1,
      }),
      deadline: Date.now() + 120_000,
      useStreaming,
      reportRetry: vi.fn(),
      onStreamDelta: async () => {},
    });
  }

  function gatewayAdapter() {
    return createGatewayAdapter(
      createGateway({
        providerRegistry: createProviderRegistry({
          providerDefaults: { fixture: { baseUrl: "https://fixture.example" } },
        }),
        presetRegistry: createPresetRegistry({
          profiles: [],
          presets: [
            {
              id: "fixture",
              name: "Fixture",
              model: "fixture",
              provider: "fixture",
              tier: "medium",
              enabled: true,
              isDefault: true,
              supportedModes: ["text", "stream"],
            },
          ],
        }),
      }),
    );
  }

  it("does not reset transport attempts when an exhausted stream enters non-stream recovery", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetch = vi.fn(
      async () =>
        new Response('{"error":{"message":"busy"}}', {
          status: 503,
          headers: { "retry-after": "0" },
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const llm = gatewayAdapter();
    const generate = vi.spyOn(llm, "generate");
    const pending = request(llm);
    const rejected = expect(pending).rejects.toMatchObject({
      code: "REQUEST_BUDGET_EXCEEDED",
      retriable: false,
    });
    await vi.runAllTimersAsync();
    await rejected;
    expect(fetch).toHaveBeenCalledTimes(8);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("falling back to non-stream"),
    );
    expect(generate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never recovers a refusal through non-stream generation", async () => {
    const error = new AiProviderError({
      code: "REFUSAL",
      provider: "fixture",
      retriable: false,
      message: "The provider refused this request",
      details: { diagnostics: { refusal: "refused" } },
    });
    const generate = vi.fn<LLMAdapter["generate"]>();
    const stream = vi.fn<NonNullable<LLMAdapter["stream"]>>(async function* () {
      throw error;
    });
    await expect(request({ generate, stream })).rejects.toBe(error);
    expect(stream).toHaveBeenCalledOnce();
    expect(generate).not.toHaveBeenCalled();
  });

  it("shares the budget with malformed-tool-arguments recovery", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('{"error":{"message":"function.arguments JSON format"}}', {
          status: 400,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          '{"choices":[{"message":{"content":"recovered"},"finish_reason":"stop"}],"usage":{}}',
        ),
      );
    vi.stubGlobal("fetch", fetch);
    const llm = gatewayAdapter();
    const generate = vi.spyOn(llm, "generate");
    expect((await request(llm, false)).content).toBe("recovered");
    expect(generate).toHaveBeenCalledTimes(2);
    const budget = generate.mock.calls[0]![0].requestBudget;
    expect(budget).toBeDefined();
    expect(generate.mock.calls[1]![0].requestBudget).toBe(budget);
    expect(budget?.attempts).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a hanging malformed-arguments recovery and preserves paired traces", async () => {
    const aborter = new AbortController();
    const events: string[] = [];
    const generate = vi
      .fn<LLMAdapter["generate"]>()
      .mockRejectedValueOnce(new Error("function.arguments JSON format"))
      .mockImplementationOnce(() => new Promise<never>(() => {}));
    const pending = request({ generate }, false, {
      turnControl: { signal: aborter.signal },
      emitter: {
        sessionId: "fixture",
        turnId: "turn",
        emit: async (type) => {
          events.push(type);
        },
      },
    });
    const rejected = expect(pending).rejects.toBeInstanceOf(TurnAbortedError);
    await vi.advanceTimersByTimeAsync(0);
    expect(generate).toHaveBeenCalledTimes(2);
    const started = Date.now();
    aborter.abort(new Error("caller cancelled"));
    await rejected;
    expect(Date.now()).toBe(started);
    expect(generate.mock.calls[1]![0].signal?.aborted).toBe(true);
    expect(events).toEqual([
      "llm.calling",
      "llm.responded",
      "llm.calling",
      "llm.responded",
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe.each(["generate", "stream"] as const)(
  "%s logical request budget",
  (mode) => {
    const run = (params: Parameters<typeof callLLMWithRetry>[0]) =>
      mode === "generate"
        ? callLLMWithRetry(params)
        : streamLLMWithRetry(params);

    it("shares one ceiling across HTTP retries, fallback targets, and runtime retries", async () => {
      let attempts = 0;
      const observed: LLMProviderRequest[] = [];
      const fetch = vi.fn(async () => {
        attempts++;
        if (attempts === 1 || attempts === 4)
          return new Response("{}", {
            status: 503,
            headers: { "retry-after": "0" },
          });
        throw new TypeError("fetch failed");
      });
      vi.stubGlobal("fetch", fetch);
      const gateway = createGateway({
        providerRegistry: createProviderRegistry({
          providerDefaults: {
            fixture: { baseUrl: "https://fixture.example/v1" },
          },
        }),
        presetRegistry: createPresetRegistry({
          profiles: [],
          presets: ["primary", "backup"].map((id) => ({
            id,
            name: id,
            model: id,
            provider: "fixture",
            tier: "medium" as const,
            enabled: true,
            isDefault: id === "primary",
            supportedModes: ["text" as const, "stream" as const],
            fallbackPresetIds: id === "primary" ? ["backup"] : [],
          })),
        }),
      });
      const adapter = createGatewayAdapter(gateway);
      const llm: LLMAdapter = {
        generate: (params) =>
          adapter.generate({
            ...params,
            onProviderRequest: (record) => observed.push(record),
          }),
        stream: (params) =>
          adapter.stream!({
            ...params,
            onProviderRequest: (record) => observed.push(record),
          }),
      };
      const requestBudget = createLlmRequestBudget({ maxAttempts: 5 });
      const onRetry = vi.fn();
      const pending = run({
        llm,
        messages,
        policy,
        requestBudget,
        deadline: Date.now() + 120_000,
        onRetry,
      });
      const rejected = expect(pending).rejects.toMatchObject({
        code: "REQUEST_BUDGET_EXCEEDED",
        retriable: false,
      });
      await vi.runAllTimersAsync();
      await rejected;
      expect(fetch).toHaveBeenCalledTimes(5);
      expect(requestBudget.attempts).toBe(5);
      expect(onRetry).toHaveBeenCalledOnce();
      expect(observed.map((record) => record.body.model)).toEqual([
        "primary",
        "primary",
        "backup",
        "primary",
        "primary",
      ]);
      expect(observed.map((record) => record.logicalAttempt)).toEqual([
        0, 1, 2, 3, 4,
      ]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("bounds an adapter that ignores its abort signal", async () => {
      const generate = vi.fn(() => new Promise<never>(() => {}));
      const stream = vi.fn(async function* () {
        await new Promise<never>(() => {});
      });
      const pending = run({
        llm: { generate, stream },
        messages,
        policy,
        requestBudget: createLlmRequestBudget({ timeoutMs: 25 }),
        deadline: Date.now() + 120_000,
      });
      const rejected = expect(pending).rejects.toMatchObject({
        code: "REQUEST_BUDGET_EXCEEDED",
        retriable: false,
      });
      await vi.advanceTimersByTimeAsync(25);
      await rejected;
      expect(mode === "generate" ? generate : stream).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("releases a granted slot if queue-wait accounting throws", async () => {
      setLLMSlotCapForTests(1);
      const holder = await acquireLLMSlot();
      const generate = vi.fn<LLMAdapter["generate"]>();
      const stream = vi.fn<NonNullable<LLMAdapter["stream"]>>();
      try {
        const pending = run({
          llm: { generate, stream },
          messages,
          policy,
          deadline: Date.now() + 120_000,
          onQueueWait() {
            throw new Error("queue observer failed");
          },
        });
        const rejected = expect(pending).rejects.toThrow(
          "queue observer failed",
        );
        await vi.advanceTimersByTimeAsync(10);
        holder.release();
        await rejected;
        const aborter = new AbortController();
        const nextSlot = acquireLLMSlot(aborter.signal);
        // Fail promptly if the error path leaked its slot instead of hanging.
        queueMicrotask(() => aborter.abort(new Error("slot leaked")));
        (await nextSlot).release();
        expect(generate).not.toHaveBeenCalled();
        expect(stream).not.toHaveBeenCalled();
      } finally {
        holder.release();
        setLLMSlotCapForTests(undefined);
      }
    });

    it("keeps the 120-second logical cap while queued execution time receives credit", async () => {
      setLLMSlotCapForTests(1);
      const holder = await acquireLLMSlot();
      const generate = vi.fn<LLMAdapter["generate"]>();
      const stream = vi.fn<NonNullable<LLMAdapter["stream"]>>();
      try {
        let settled = false;
        const pending = run({
          llm: { generate, stream },
          messages,
          policy,
          deadline: Date.now() + 100,
        });
        void pending.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        const rejected = expect(pending).rejects.toMatchObject({
          code: "REQUEST_BUDGET_EXCEEDED",
        });
        await vi.advanceTimersByTimeAsync(119_999);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await rejected;
        expect(generate).not.toHaveBeenCalled();
        expect(stream).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        holder.release();
        setLLMSlotCapForTests(undefined);
      }
    });
  },
);
