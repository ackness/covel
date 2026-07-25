/**
 * ctx.images wiring — plan task 8 (D2).
 *
 * `createRuntimeImagesContext` (runtime-images-context.ts) is a pure builder;
 * this test pins the *assembly* decision in `executeFunctionRuntime`: when is
 * `FunctionHandlerContext.images` actually constructed and handed to a
 * function-runtime handler, and when does it correctly degrade to
 * `undefined` so plugins can null-check.
 */

import { describe, it, expect } from "vitest";
import type { RuntimeManifest, TurnInput } from "@covel/shared";
import { createMemoryStore, createMemoryMediaStore } from "@covel/store";
import { executeTurn } from "../src/turn-executor/turn-executor.js";
import type { TurnExecutorDeps } from "../src/turn-executor/turn-executor.js";
import type { PluginRuntimeGateway } from "@covel/plugin-loader";

function fnManifest(
  name: string,
  overrides: Partial<RuntimeManifest> = {},
): RuntimeManifest {
  return {
    name,
    pluginId: name.split("/")[0]!,
    description: name,
    stage: "narrative",
    runtimeType: "function",
    handler: "./h.js",
    trigger: { type: "manual" },
    ...overrides,
  };
}

function makeTurnInput(runtimeId: string): TurnInput {
  return {
    sessionId: "sess-images",
    turnId: "turn-images",
    playerMessage: "",
    manualTrigger: { runtimeId },
  };
}

function gatewayWithImages(): PluginRuntimeGateway {
  return {
    generateText: async () => ({
      text: "",
      finishReason: "stop",
      usage: { inputTokens: 0, outputTokens: 0 },
    }),
    generateObject: async () => ({
      object: {},
      finishReason: "stop",
      usage: { inputTokens: 0, outputTokens: 0 },
    }),
    resolveSlot: () => null,
    generateImage: async () => ({
      images: [
        { kind: "bytes", bytes: new Uint8Array([1]), mime: "image/png" },
      ],
      warnings: [],
    }),
  };
}

async function runWithHandler(
  runtimeId: string,
  handler: (ctx: { images?: unknown }) => Promise<{ ok: boolean }>,
  extraDeps: Partial<TurnExecutorDeps>,
): Promise<boolean> {
  const target = fnManifest(runtimeId);
  const store = createMemoryStore();
  let sawImages: unknown = "unset";

  const deps: TurnExecutorDeps = {
    loadRuntime: async () => ({
      manifest: target,
      promptTemplate: "",
      handler: async (ctx) => {
        sawImages = ctx.images;
        return handler(ctx);
      },
    }),
    llm: {
      generate: async () => ({
        content: "{}",
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
    },
    store,
    ...extraDeps,
  };

  await executeTurn(makeTurnInput(runtimeId), [target], deps);
  return Boolean(sawImages);
}

describe("ctx.images wiring (plan task 8)", () => {
  it("builds ctx.images when the gateway supports generateImage and mediaStore is wired", async () => {
    const hasImages = await runWithHandler(
      "plug/needs-images",
      async () => ({ ok: true }),
      { gateway: gatewayWithImages(), mediaStore: createMemoryMediaStore() },
    );
    expect(hasImages).toBe(true);
  });

  it("leaves ctx.images undefined when the gateway has no generateImage (legacy facade)", async () => {
    const legacyGateway: PluginRuntimeGateway = {
      generateText: async () => ({
        text: "",
        finishReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
      generateObject: async () => ({
        object: {},
        finishReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
      resolveSlot: () => null,
    };
    const hasImages = await runWithHandler(
      "plug/no-image-wire",
      async () => ({ ok: true }),
      { gateway: legacyGateway, mediaStore: createMemoryMediaStore() },
    );
    expect(hasImages).toBe(false);
  });

  it("leaves ctx.images undefined when no mediaStore is wired", async () => {
    const hasImages = await runWithHandler(
      "plug/no-media-store",
      async () => ({ ok: true }),
      { gateway: gatewayWithImages() },
    );
    expect(hasImages).toBe(false);
  });
});
