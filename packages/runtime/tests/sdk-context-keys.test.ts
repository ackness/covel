/**
 * The context objects the host really builds for function handlers and agent
 * guards carry only fields the public SDK types, and every field the SDK marks
 * required. `sdk-alignment.ts` in `@covel/plugin-test-utils` checks the host's
 * type against the SDK's; this test checks the objects themselves.
 */

import { describe, expect, it } from "vitest";
import type { PluginFunctionContext } from "@covel/plugin-handlers-utils";
import type { RuntimeManifest, TurnInput } from "@covel/shared";
import type { PluginRuntimeGateway } from "@covel/shared/plugin-runtime";
import { createMemoryMediaStore, createMemoryStore } from "@covel/store/memory";
import { runTurnPipeline } from "../src/turn-executor/turn-executor.js";
import type { TurnExecutorDeps } from "../src/turn-executor/turn-executor.js";

// `satisfies` fails to compile when the SDK gains or loses a field.
const SDK_CONTEXT_KEYS = {
  sessionId: "required",
  turnId: "required",
  pluginId: "required",
  runtimeId: "required",
  playerMessage: "required",
  playerActions: "required",
  logicalTurn: "optional",
  locale: "optional",
  messages: "optional",
  session: "required",
  store: "required",
  world: "optional",
  services: "optional",
  tools: "optional",
  manualPayload: "optional",
  resumeData: "optional",
  resumedFromSuspensionId: "optional",
  triggerEvent: "optional",
  inputs: "optional",
  exports: "optional",
  activation: "optional",
  execution: "optional",
  recursiveCall: "required",
  recursionDepth: "required",
  userSettings: "optional",
  pluginData: "optional",
  logger: "optional",
  progress: "optional",
  gateway: "optional",
  utils: "optional",
  media: "optional",
  images: "optional",
  speech: "optional",
  music: "optional",
  assetProgress: "optional",
  random: "required",
  signal: "optional",
} as const satisfies Record<
  keyof PluginFunctionContext,
  "required" | "optional"
>;

const SESSION_ID = "sess-sdk-keys";

function gateway(): PluginRuntimeGateway {
  const usage = { inputTokens: 0, outputTokens: 0 };
  const audio = { mimeType: "audio/wav", data: new Uint8Array([1]) };
  return {
    generateText: async () => ({ text: "", finishReason: "stop", usage }),
    generateObject: async <T>() => ({
      object: {} as T,
      finishReason: "stop",
      usage,
    }),
    resolveSlot: () => null,
    generateImage: async () => ({
      target: {
        provider: "test",
        model: "image",
        protocol: "openai-chat-v1",
        metadata: {},
      },
      images: [],
      warnings: [],
    }),
    synthesizeSpeech: async () => ({ audio, warnings: [] }),
    composeMusic: async () => ({ audio, warnings: [] }),
    transcribeAudio: async () => ({ text: "", warnings: [] }),
  };
}

async function seededStore() {
  const store = createMemoryStore();
  const now = new Date().toISOString();
  await store.createSession({
    id: SESSION_ID,
    worldId: "w",
    locale: "en-US",
    status: "active",
    phase: "playing",
    completedPlayerTurns: 2,
    seats: [
      { id: "main", controller: "human", role: "player", characters: "auto" },
    ],
    setupRuntimes: {
      "p/opening": {
        state: "done",
        resolution: "waived",
        generation: 1,
        attempts: 2,
        completedAt: now,
        pluginVersion: "1.0.0",
      },
    },
    activePlugins: ["p"],
    createdAt: now,
    updatedAt: now,
  });
  return store;
}

function expectSdkKeys(context: object) {
  const keys = Object.keys(context);
  const known = new Set<string>(Object.keys(SDK_CONTEXT_KEYS));
  expect(keys.filter((key) => !known.has(key))).toEqual([]);
  const required = Object.entries(SDK_CONTEXT_KEYS)
    .filter(([, presence]) => presence === "required")
    .map(([key]) => key);
  expect(required.filter((key) => !keys.includes(key))).toEqual([]);
}

const input: TurnInput = {
  origin: "player",
  sessionId: SESSION_ID,
  turnId: "turn-sdk-keys",
  playerMessage: "look around",
};

describe("host context against the public SDK", () => {
  it("gives a function handler only SDK fields and a projected session", async () => {
    const manifest: RuntimeManifest = {
      name: "p/fn",
      pluginId: "p",
      description: "p/fn",
      stage: "narrative",
      runtimeType: "function",
      handler: "./h.js",
      trigger: { type: "manual" },
    };
    let seen: PluginFunctionContext | undefined;
    let session: unknown;
    const deps: TurnExecutorDeps = {
      loadRuntime: async () => ({
        manifest,
        promptTemplate: "",
        handler: async (ctx) => {
          seen = ctx;
          session = await ctx.store.getSession();
          return { outcome: "success", value: { ok: true } };
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
      store: await seededStore(),
      gateway: gateway(),
      mediaStore: createMemoryMediaStore(),
    };

    await runTurnPipeline(
      { ...input, manualTrigger: { runtimeId: "p/fn" } },
      [manifest],
      deps,
    );

    expect(seen).toBeDefined();
    expectSdkKeys(seen!);
    expect(seen!.images).toBeDefined();
    expect(seen!.speech).toBeDefined();
    expect(seen!.music).toBeDefined();
    expect(seen!.execution).toEqual({ origin: "player" });
    expect(session).toEqual({
      phase: "playing",
      completedPlayerTurns: 2,
      locale: "en-US",
      setupRuntimes: { "p/opening": { state: "done", resolution: "waived" } },
    });
  });

  it("gives an agent guard only SDK fields", async () => {
    const manifest = {
      name: "p/agent",
      pluginId: "p",
      description: "p/agent",
      stage: "narrative",
      runtimeType: "agent",
      guard: "./guard.js",
      trigger: { type: "auto" },
      outputKind: "system",
    } as RuntimeManifest;
    let seen: PluginFunctionContext | undefined;
    const deps: TurnExecutorDeps = {
      loadRuntime: async (m) => ({
        manifest: m,
        promptTemplate: "",
        guard: async (ctx) => {
          seen = ctx;
          return { skip: true };
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
      store: await seededStore(),
      gateway: gateway(),
      mediaStore: createMemoryMediaStore(),
      getPluginSource: () => "builtin",
    };

    await runTurnPipeline(input, [manifest], deps);

    expect(seen).toBeDefined();
    expectSdkKeys(seen!);
  });
});
