import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeManifest, TurnInput } from "@covel/shared";
import type { LoadedRuntime, PluginRuntimeGateway } from "@covel/plugin-loader";
import { createMemoryStore } from "@covel/store/memory";
import { createEventBus } from "@covel/events";
import { executeTurn } from "../src/turn-executor/turn-executor.js";
import type { TurnExecutorDeps } from "../src/turn-executor/turn-executor.js";
import { promptCacheKeyFor } from "../src/llm/prompt-cache-key.js";
import { createPluginRuntimeGateway } from "../src/function-runtime/plugin-runtime-gateway.js";

const manifest: RuntimeManifest = {
  name: "fn-plugin/extract",
  pluginId: "fn-plugin",
  description: "test",
  pluginType: "plugin",
  stage: "narrative",
  trigger: { type: "auto" },
  model: "gpt-4o-mini",
  runtimeType: "function",
};

const input: TurnInput = {
  origin: "player",
  sessionId: "sess-key",
  turnId: "turn-key",
  playerMessage: "hi",
};

async function runWith(
  loaded: LoadedRuntime,
  gateway: PluginRuntimeGateway,
  locale?: string,
): Promise<void> {
  await executeTurn({ ...input, locale }, [loaded.manifest], {
    loadRuntime: async () => loaded,
    llm: { generate: vi.fn() },
    store: createMemoryStore(),
    eventBus: createEventBus(),
    gateway,
  } as unknown as TurnExecutorDeps);
}

describe("prompt cache key on a function runtime's model calls", () => {
  it("fills the key from the session and the runtime, and replaces one the plugin passes", async () => {
    const generateText = vi.fn().mockResolvedValue({
      text: "ok",
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const gateway = {
      generateText,
      generateObject: vi.fn(),
      resolveSlot: () => null,
    } as unknown as PluginRuntimeGateway;
    const loaded: LoadedRuntime = {
      manifest,
      promptTemplate: "",
      handler: async (ctx) => {
        await ctx.gateway!.generateText({ prompt: "one" });
        await ctx.gateway!.generateText({
          prompt: "two",
          promptCacheKey: "chosen-by-plugin",
        } as never);
        return { outcome: "success", value: {} };
      },
    };

    await runWith(loaded, gateway);

    const expected = promptCacheKeyFor("sess-key", "fn-plugin/extract");
    expect(generateText).toHaveBeenCalledTimes(2);
    for (const [call] of generateText.mock.calls)
      expect(call.promptCacheKey).toBe(expected);
  });

  it("the facade over the provider gateway passes the key on and leaves it out when absent", async () => {
    const generateText = vi.fn().mockResolvedValue({
      text: "ok",
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const facade = createPluginRuntimeGateway({
      generateText,
      generateObject: vi.fn(),
      resolveSlot: () => null,
    });
    await facade.generateText({ prompt: "a", promptCacheKey: "k" });
    await facade.generateText({ prompt: "b" });
    expect(generateText.mock.calls[0]![0].promptCacheKey).toBe("k");
    expect(generateText.mock.calls[1]![0]).not.toHaveProperty("promptCacheKey");
  });
});

afterEach(() => vi.unstubAllEnvs());
it.each([
  ["zh-CN", "", "zh"],
  ["en-US", "", "en"],
  ["ja-JP", "", "en"],
  ["zh-CN", "en", "en"],
  ["en-US", "zh", "zh"],
])(
  "binds function text and object calls to session %s with override %s",
  async (locale, override, expected) => {
    vi.stubEnv("COVEL_INSTRUCTION_LOCALE", override);
    const generateText = vi.fn().mockResolvedValue({
      text: "{}",
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const generateObject = vi.fn().mockResolvedValue({
      object: {},
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const gateway = createPluginRuntimeGateway(
      { generateText, generateObject, resolveSlot: () => null },
      { toZodSchema: () => z.object({}) },
    );
    await runWith(
      {
        manifest,
        promptTemplate: "",
        handler: async (ctx) => {
          await ctx.gateway!.generateText({
            prompt: "one",
            instructionLocale: "en",
          } as never);
          await ctx.gateway!.generateObject({ prompt: "two", schema: {} });
          return { outcome: "success", value: {} };
        },
      },
      gateway,
      locale,
    );
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({ instructionLocale: expected }),
      expect.anything(),
    );
    expect(generateObject).toHaveBeenCalledWith(
      expect.objectContaining({ instructionLocale: expected }),
      expect.anything(),
    );
  },
);
