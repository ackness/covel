/**
 * ctx.music wiring — mirrors runtime-speech-wiring.test.ts: pins when the
 * function runner hands `FunctionHandlerContext.music` to a handler, when it
 * degrades to `undefined`, and that the handle stops working after the run.
 */

import { describe, it, expect } from "vitest";
import type { RuntimeManifest, TurnInput } from "@covel/shared";
import { createMemoryStore, createMemoryMediaStore } from "@covel/store/memory";
import { executeTurn } from "../src/turn-executor/turn-executor.js";
import type { TurnExecutorDeps } from "../src/turn-executor/turn-executor.js";
import type { PluginRuntimeGateway } from "@covel/plugin-loader";

function fnManifest(name: string): RuntimeManifest {
  return {
    name,
    pluginId: name.split("/")[0]!,
    description: name,
    stage: "narrative",
    runtimeType: "function",
    handler: "./h.js",
    trigger: { type: "manual" },
  };
}

function makeTurnInput(runtimeId: string): TurnInput {
  return {
    origin: "player",
    sessionId: "sess-music",
    turnId: "turn-music",
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
    generateObject: async <T>() => ({
      object: {} as T,
      finishReason: "stop",
      usage: { inputTokens: 0, outputTokens: 0 },
    }),
    resolveSlot: () => null,
  };
}

function gatewayWithMusic(): PluginRuntimeGateway {
  return {
    ...baseGateway(),
    composeMusic: async () => ({
      audio: { mimeType: "audio/mpeg", data: new Uint8Array([1]) },
      warnings: [],
    }),
  };
}

type MusicHandle = NonNullable<
  Parameters<
    NonNullable<
      NonNullable<
        Awaited<ReturnType<TurnExecutorDeps["loadRuntime"]>>
      >["handler"]
    >
  >[0]["music"]
>;

async function runWithHandler(
  runtimeId: string,
  extraDeps: Partial<TurnExecutorDeps>,
): Promise<MusicHandle | undefined> {
  const target = fnManifest(runtimeId);
  let seen: MusicHandle | undefined;

  const deps: TurnExecutorDeps = {
    loadRuntime: async () => ({
      manifest: target,
      promptTemplate: "",
      handler: async (ctx) => {
        seen = ctx.music;
        return { outcome: "success", value: {} };
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
    store: createMemoryStore(),
    ...extraDeps,
  };

  await executeTurn(makeTurnInput(runtimeId), [target], deps);
  return seen;
}

describe("ctx.music wiring", () => {
  it("hands the handler ctx.music when the gateway composes music and a mediaStore is wired, and revokes it after the run", async () => {
    const music = await runWithHandler("plug/needs-music", {
      gateway: gatewayWithMusic(),
      mediaStore: createMemoryMediaStore(),
    });
    expect(music).toBeDefined();
    expect(() => music!.isAvailable()).toThrow(/revoked/);
  });

  it("leaves ctx.music undefined when the gateway cannot compose music", async () => {
    expect(
      await runWithHandler("plug/no-music-wire", {
        gateway: baseGateway(),
        mediaStore: createMemoryMediaStore(),
      }),
    ).toBeUndefined();
  });

  it("leaves ctx.music undefined when no mediaStore is wired", async () => {
    expect(
      await runWithHandler("plug/no-media-store", {
        gateway: gatewayWithMusic(),
      }),
    ).toBeUndefined();
  });
});
