import { expect, it, vi } from "vitest";
import { z } from "zod";
import type { RuntimeManifest } from "@covel/shared";
import type { LoadedRuntime, PluginRuntimeGateway } from "@covel/plugin-loader";
import { createMemoryStore } from "@covel/store/memory";
import { createEventBus } from "@covel/events";
import { runTurnPipeline } from "../src/turn-executor/turn-executor.js";
import { createPluginRuntimeGateway } from "../src/function-runtime/plugin-runtime-gateway.js";

it.each(["fast", undefined])(
  "defaults text calls to function.model=%s and preserves explicit presets without reading session overrides",
  async (model) => {
    const manifest: RuntimeManifest = {
      name: "fixture/extract",
      pluginId: "fixture",
      description: "model binding fixture",
      runtimeType: "function",
      stage: "narrative",
      trigger: { type: "auto" },
      model,
    };
    const usage = { inputTokens: 1, outputTokens: 1 };
    const generateText = vi
      .fn()
      .mockResolvedValue({ text: "ok", finishReason: "stop", usage });
    const generateObject = vi
      .fn()
      .mockResolvedValue({ object: {}, finishReason: "stop", usage });
    const otherCalls = {
      generateImage: vi.fn().mockResolvedValue({ images: [] }),
      synthesizeSpeech: vi.fn().mockResolvedValue({}),
      transcribeAudio: vi.fn().mockResolvedValue({ text: "ok" }),
      composeMusic: vi.fn().mockResolvedValue({}),
      evaluate: vi.fn().mockResolvedValue({ answers: {}, usage }),
      resolveSlot: vi.fn().mockReturnValue(null),
    };
    const gateway: PluginRuntimeGateway = {
      ...createPluginRuntimeGateway(
        { generateText, generateObject, resolveSlot: () => null },
        { toZodSchema: () => z.object({}) },
      ),
      ...otherCalls,
    };
    const loaded: LoadedRuntime = {
      manifest,
      promptTemplate: "",
      handler: async (ctx) => {
        const bound = ctx.gateway!;
        for (const presetId of [undefined, "explicit"]) {
          await bound.generateText({ prompt: "text", presetId });
          await bound.generateObject({
            prompt: "object",
            schema: {},
            presetId,
          });
          await bound.generateImage!({ prompt: "image", presetId });
          await bound.synthesizeSpeech!({ text: "speech", presetId });
          await bound.transcribeAudio!({
            audio: { data: new Uint8Array(), mimeType: "audio/wav" },
            presetId,
          });
          await bound.composeMusic!({ prompt: "music", presetId });
          await bound.evaluate!({ state: {}, questions: {}, presetId });
          bound.resolveSlot({ presetId });
        }
        return { outcome: "success", value: {} };
      },
    };
    const resolveModel = vi.fn(() => "session-override");
    const result = await runTurnPipeline(
      {
        origin: "player",
        sessionId: "session-model",
        turnId: "turn-model",
        playerMessage: "test",
        runtimeModelOverrides: { "fixture/extract": "session-override" },
      },
      [manifest],
      {
        loadRuntime: async () => loaded,
        llm: { generate: vi.fn() },
        store: createMemoryStore(),
        eventBus: createEventBus(),
        gateway,
        resolveModel,
      },
    );
    expect(result.runtimeResults).toEqual([
      expect.objectContaining({ runtimeId: manifest.name, status: "success" }),
    ]);
    for (const call of [generateText, generateObject]) {
      expect(call.mock.calls.map(([input]) => input.presetId)).toEqual([
        model,
        "explicit",
      ]);
    }
    for (const call of Object.values(otherCalls)) {
      expect(call.mock.calls.map(([input]) => input.presetId)).toEqual([
        undefined,
        "explicit",
      ]);
    }
    expect(resolveModel).not.toHaveBeenCalled();
  },
);
