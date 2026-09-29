import { createLlmRequestBudget, type LLMProviderRequest } from "@covel/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGateway } from "../src/gateway.js";
import { createPresetRegistry } from "../src/preset-registry.js";
import { createProviderRegistry } from "../src/provider-registry.js";
import type { ProviderLifecycleHook } from "../src/types.js";

const messages = [{ role: "user" as const, content: "Hello" }];
const response = (status = 200) =>
  new Response(
    JSON.stringify(
      status === 200
        ? {
            choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
            usage: {},
          }
        : { error: { message: "temporarily unavailable" } },
    ),
    { status, headers: { "retry-after": "0" } },
  );

function fixture(hooks: ProviderLifecycleHook[] = []) {
  const presetRegistry = createPresetRegistry({
    profiles: [],
    presets: ["primary", "backup"].map((id) => ({
      id,
      name: id,
      provider: "fixture",
      model: id,
      tier: "medium" as const,
      supportedModes: ["text" as const, "stream" as const],
      enabled: true,
      isDefault: id === "primary",
      fallbackPresetIds: id === "primary" ? ["backup"] : [],
    })),
  });
  const gateway = createGateway({
    presetRegistry,
    providerRegistry: createProviderRegistry({
      providers: {
        fixture: { defaults: { baseUrl: "https://fixture.example/v1" }, hooks },
      },
    }),
  });
  return { gateway, presetRegistry };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("logical provider request budgets", () => {
  it("shares actual transport attempts across HTTP retry and fallback", async () => {
    const fetch = vi.fn(async () => response(503));
    vi.stubGlobal("fetch", fetch);
    const requestBudget = createLlmRequestBudget({ maxAttempts: 5 });
    const observations: LLMProviderRequest[] = [];
    const call = fixture().gateway.generateText(
      { messages },
      {
        requestBudget,
        onProviderRequest: (record) => observations.push(record),
      },
    );
    const rejected = expect(call).rejects.toMatchObject({
      code: "REQUEST_BUDGET_EXCEEDED",
      retriable: false,
    });
    await vi.runAllTimersAsync();
    await rejected;
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(requestBudget.attempts).toBe(5);
    expect(observations.map((record) => record.body.model)).toEqual([
      "primary",
      "primary",
      "primary",
      "primary",
      "backup",
    ]);
    expect(observations.map((record) => record.logicalAttempt)).toEqual([
      0, 1, 2, 3, 4,
    ]);
    expect(observations.map((record) => record.transportRetryReason)).toEqual([
      undefined,
      "http-5xx",
      "http-5xx",
      "http-5xx",
      undefined,
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns the last allowed successful attempt", async () => {
    const fetch = vi.fn(async () => response());
    vi.stubGlobal("fetch", fetch);
    const result = await fixture().gateway.generateText(
      { messages },
      {
        requestBudget: createLlmRequestBudget({ maxAttempts: 1 }),
      },
    );
    expect(result.text).toBe("ok");
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a hanging hook phase and observes its later rejection", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    let rejectHook!: (error: Error) => void;
    const onRequestStart = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectHook = reject;
        }),
    );
    const secondHook = vi.fn();
    const fetch = vi.fn(async () => response());
    vi.stubGlobal("fetch", fetch);
    const call = fixture([
      { onRequestStart },
      { onRequestStart: secondHook },
    ]).gateway.generateText({ messages });
    await vi.advanceTimersByTimeAsync(999);
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect((await call).text).toBe("ok");
    expect(secondHook).not.toHaveBeenCalled();
    rejectHook(new Error("late observer failure"));
    await Promise.resolve();
    expect(warning).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["onRequestSuccess", "onRequestError"] as const)(
    "bounds a hanging %s hook",
    async (name) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const fetch = vi.fn(async () =>
        response(name === "onRequestError" ? 400 : 200),
      );
      vi.stubGlobal("fetch", fetch);
      const call = fixture([
        { [name]: () => new Promise<void>(() => {}) },
      ]).gateway.generateText({ messages });
      const result =
        name === "onRequestError"
          ? expect(call).rejects.toMatchObject({ statusCode: 400 })
          : expect(call).resolves.toMatchObject({ text: "ok" });
      await vi.advanceTimersByTimeAsync(1_000);
      await result;
      expect(fetch).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("does not change successful calls when a hook rejects", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response()),
    );
    const result = await fixture([
      {
        onRequestStart: async () => {
          throw new Error("observer failed");
        },
      },
    ]).gateway.generateText({ messages });
    expect(result.text).toBe("ok");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["caller", "deadline"] as const)(
    "cleans up an overlay when %s cancels a hanging hook",
    async (source) => {
      const fetch = vi.fn(async () => response());
      vi.stubGlobal("fetch", fetch);
      const { gateway, presetRegistry } = fixture([
        { onRequestStart: () => new Promise<void>(() => {}) },
      ]);
      const removePreset = vi.spyOn(presetRegistry, "removePreset");
      const aborter = new AbortController();
      const call = gateway.generateText(
        { presetId: "local", messages },
        {
          signal: aborter.signal,
          requestBudget: createLlmRequestBudget({ timeoutMs: 50 }),
          slotOverrides: {
            customPresets: [
              {
                id: "local",
                name: "Local",
                provider: "fixture",
                model: "primary",
              },
            ],
          },
        },
      );
      const rejected =
        source === "caller"
          ? expect(call).rejects.toThrow("caller cancelled")
          : expect(call).rejects.toMatchObject({
              code: "REQUEST_BUDGET_EXCEEDED",
              retriable: false,
            });
      await vi.advanceTimersByTimeAsync(10);
      if (source === "caller") aborter.abort(new Error("caller cancelled"));
      await vi.advanceTimersByTimeAsync(40);
      await rejected;
      expect(fetch).not.toHaveBeenCalled();
      expect(removePreset).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("bounds a stalled streaming body that ignores fetch cancellation", async () => {
    const cancel = vi.fn();
    const fetch = vi.fn(
      async () =>
        new Response(new ReadableStream({ cancel }), {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const call = Array.fromAsync(
      fixture().gateway.streamText(
        { messages },
        {
          requestBudget: createLlmRequestBudget({ timeoutMs: 50 }),
        },
      ),
    );
    const rejected = expect(call).rejects.toMatchObject({
      code: "REQUEST_BUDGET_EXCEEDED",
    });
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    expect(fetch).toHaveBeenCalledOnce();
    // The mock response is not wired to fetch's signal; the gateway must still
    // settle without awaiting its uncooperative reader indefinitely.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves the media backend's longer polling policy without an explicit budget", async () => {
    const start = Date.now();
    const fetch = vi.fn(
      async (_url: string, init: RequestInit) =>
        new Response(
          JSON.stringify({
            output:
              init.method === "POST"
                ? { task_id: "image-task" }
                : Date.now() - start < 122_000
                  ? { task_status: "RUNNING" }
                  : {
                      task_status: "SUCCEEDED",
                      results: [{ url: "https://fixture.example/image.png" }],
                    },
          }),
        ),
    );
    vi.stubGlobal("fetch", fetch);
    const gateway = createGateway({
      providerRegistry: createProviderRegistry({
        providerDefaults: {
          fixture: { baseUrl: "https://fixture.example" },
        },
      }),
      presetRegistry: createPresetRegistry({
        profiles: [],
        presets: [
          {
            id: "image",
            name: "Image",
            provider: "fixture",
            model: "wan2.2-t2i",
            tier: "medium",
            enabled: true,
            supportedModes: ["image"],
            tag: "image",
            providerRequestMetadata: { imageWire: "dashscope-wan" },
          },
        ],
      }),
    });
    const pending = gateway.generateImage({
      presetId: "image",
      prompt: "Landscape",
    });
    await vi.advanceTimersByTimeAsync(122_000);
    expect((await pending).images).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(62);
    expect(vi.getTimerCount()).toBe(0);
  });
});
