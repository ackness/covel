/**
 * ctx.speech wiring — mirrors runtime-images-wiring.test.ts: pins when
 * `FunctionHandlerContext.speech` is constructed and when it degrades to
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
    priority: 500,
    runtimeType: "function",
    handler: "./h.js",
    trigger: { type: "manual" },
    ...overrides,
  };
}

function makeTurnInput(runtimeId: string): TurnInput {
  return {
    sessionId: "sess-speech",
    turnId: "turn-speech",
    playerMessage: "",
    manualTrigger: { runtimeId },
  };
}

function baseGateway(): PluginRuntimeGateway {
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
  };
}

function gatewayWithSpeech(): PluginRuntimeGateway {
  return {
    ...baseGateway(),
    synthesizeSpeech: async () => ({
      audio: { mimeType: "audio/mpeg", data: new Uint8Array([1]) },
      warnings: [],
    }),
    transcribeAudio: async () => ({ text: "", warnings: [] }),
  };
}

async function runWithHandler(
  runtimeId: string,
  extraDeps: Partial<TurnExecutorDeps>,
): Promise<boolean> {
  const target = fnManifest(runtimeId);
  const store = createMemoryStore();
  let sawSpeech: unknown = "unset";

  const deps: TurnExecutorDeps = {
    loadRuntime: async () => ({
      manifest: target,
      promptTemplate: "",
      handler: async (ctx) => {
        sawSpeech = ctx.speech;
        return { ok: true };
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
  return Boolean(sawSpeech);
}

describe("ctx.speech wiring", () => {
  it("builds ctx.speech when the gateway supports both speech halves and mediaStore is wired", async () => {
    const hasSpeech = await runWithHandler("plug/needs-speech", {
      gateway: gatewayWithSpeech(),
      mediaStore: createMemoryMediaStore(),
    });
    expect(hasSpeech).toBe(true);
  });

  it("leaves ctx.speech undefined when the gateway has no speech methods", async () => {
    const hasSpeech = await runWithHandler("plug/no-speech-wire", {
      gateway: baseGateway(),
      mediaStore: createMemoryMediaStore(),
    });
    expect(hasSpeech).toBe(false);
  });

  it("leaves ctx.speech undefined when no mediaStore is wired", async () => {
    const hasSpeech = await runWithHandler("plug/no-media-store", {
      gateway: gatewayWithSpeech(),
    });
    expect(hasSpeech).toBe(false);
  });
});
