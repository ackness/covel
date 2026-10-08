import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGateway,
  createPresetRegistry,
  createProviderRegistry,
} from "@covel/ai-provider";
import { createPluginRuntimeGateway } from "@covel/runtime";
import { outboundFetch } from "../../../../packages/ai-provider/src/outbound-network.js";
import extractMemory from "../../../../plugins/memory/server/extract.js";

vi.mock("../../../../packages/ai-provider/src/outbound-network.js", () => ({
  outboundFetch: vi.fn(),
}));
const fetch = vi.mocked(outboundFetch);
const input = {
  sessionId: "session",
  narrativeText: "The gate opened.",
  currentBlocks: [],
};
const success = () =>
  new Response(
    JSON.stringify({
      choices: [
        {
          message: { content: '{"scene":"The gate is open."}' },
          finish_reason: "stop",
        },
      ],
      usage: {},
    }),
    { status: 200 },
  );

function fixture(explicitThinking = false) {
  const gateway = createGateway({
    presetRegistry: createPresetRegistry({
      profiles: [],
      presets: [
        {
          id: "memory",
          name: "Memory",
          provider: "fixture",
          model: "qwen3.8-flash",
          protocol: "openai-chat-v1",
          tier: "medium",
          enabled: true,
          supportedModes: ["text"],
        },
      ],
    }),
    providerRegistry: createProviderRegistry({
      providers: {
        fixture: { defaults: { baseUrl: "https://provider.example" } },
      },
    }),
  });
  const adapter = createPluginRuntimeGateway(
    gateway,
    explicitThinking
      ? {
          slotOverrides: {
            parameterOverrides: {
              memory: { reasoningEffort: "automatic" },
            },
          },
        }
      : {},
  );
  const blocks = new Map<string, unknown>();
  return {
    blocks,
    async run() {
      const result = await extractMemory({
        sessionId: "session",
        pluginId: "memory",
        locale: "en-US",
        signal: AbortSignal.timeout(120_000),
        gateway: adapter,
        inputs: {
          turn: {
            value: {
              turnId: "turn",
              narrativeText: input.narrativeText,
              playerMessage: "go",
              toolCallSummaries: [],
            },
          },
        },
        pluginData: {
          get: async () => null,
          list: async () => [],
          set: async (_ns: string, key: string, value: unknown) => {
            blocks.set(key, value);
          },
        },
      });
      return result;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  fetch.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  // Native AbortSignal timers bypass Vitest's clock. Keep real abort semantics
  // while driving the host-selected deadline with virtual time.
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(
      () => controller.abort(new DOMException("Timed out", "TimeoutError")),
      ms,
    );
    return controller.signal;
  });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("memory LLM request policy", () => {
  it.each([false, true])(
    "defaults extraction to no thinking while preserving explicit settings (%s)",
    async (explicitThinking) => {
      fetch.mockResolvedValue(success());
      const result = await fixture(explicitThinking).run();
      expect(result).toMatchObject({
        outcome: "success",
        value: { blocksChanged: ["scene"] },
      });
      const body = JSON.parse(String(fetch.mock.calls[0]![1]!.body));
      expect(body.enable_thinking).toBe(explicitThinking);
    },
  );

  it("accepts a complete extraction after the former 60-second deadline", async () => {
    fetch.mockImplementation(
      async (_url, init) =>
        new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => resolve(success()), 90_000);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(init.signal?.reason);
          });
        }),
    );
    const memory = fixture();
    const update = memory.run();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(await update).toMatchObject({
      outcome: "success",
      value: { blocksChanged: ["scene"] },
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(memory.blocks.get("scene")).toMatchObject({
      content: "The gate is open.",
    });
  });

  it("aborts a stalled request at 120 seconds without retrying the timeout", async () => {
    fetch.mockImplementation(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          );
        }),
    );
    const memory = fixture();
    const update = memory.run();
    let settled = false;
    const rejected = expect(update).rejects.toThrow("Timed out");
    void update.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.advanceTimersByTimeAsync(119_999);
    expect(fetch).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(fetch).toHaveBeenCalledOnce();
  });
});
