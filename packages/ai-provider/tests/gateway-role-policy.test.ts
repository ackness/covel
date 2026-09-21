import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  AiProviderError,
  createGateway,
  createPresetRegistry,
  createProviderRegistry,
  createSlotRegistry,
  parseLlmConfig,
} from "../src/index.js";
import type { ModelProviderAdapter } from "../src/adapters/adapter.js";
import type { GatewayOptions } from "../src/gateway.js";

function setup() {
  const { aiConfig } = parseLlmConfig(`
[covel.story]
provider = "fixture"
model = "base-story"
baseUrl = "https://fixture.invalid/v1"
protocol = "openai-chat-v1"
[covel.utility]
provider = "fixture"
model = "base-utility"
baseUrl = "https://fixture.invalid/v1"
protocol = "openai-chat-v1"
fallback = "story"
[covel.intent]
provider = "typesafe"
model = "jev-latest"
baseUrl = "https://api.typesafe.ai/v1"
protocol = "typesafe-systemone-v1"
`);
  const calls: string[] = [];
  function attempt(model: string) {
    calls.push(model);
    if (model === "failing-model")
      throw new AiProviderError({
        code: "PROVIDER_ERROR",
        provider: "fixture",
        message: "Synthetic failure",
        retriable: true,
      });
  }
  const adapter: ModelProviderAdapter = {
    generateText: vi.fn(async (_config, params) => {
      attempt(params.model);
      return {
        text: "ok",
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    }),
    generateObject: vi.fn(async (_config, params) => {
      attempt(params.model);
      return {
        object: params.schema.parse({ ok: true }),
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    }),
    async *streamText(_config, params) {
      attempt(params.model);
      yield { type: "text-delta", textDelta: "ok" };
      yield {
        type: "done",
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
    embed: vi.fn(),
  };
  const providerRegistry = createProviderRegistry({
    providers: {
      fixture: {
        adapter,
        defaults: {
          baseUrl: "https://fixture.invalid/v1",
          protocol: "openai-chat-v1",
        },
      },
    },
  });
  const presetRegistry = createPresetRegistry(aiConfig);
  const slotRegistry = createSlotRegistry({ presetRegistry });
  slotRegistry.configure({
    slots: Object.fromEntries(
      aiConfig.presets.map((p) => [
        p.defaultSlot!,
        {
          slotId: p.defaultSlot!,
          presetId: p.id,
          tag: p.tag!,
        },
      ]),
    ),
  });
  const gateway = createGateway({
    providerRegistry,
    presetRegistry,
    slotRegistry,
  });
  const options: GatewayOptions = {
    slotOverrides: {
      slotBindings: {
        utility: { modelRef: "primary" },
        story: { modelRef: "backup" },
      },
      customPresets: [
        {
          id: "primary",
          provider: "fixture",
          model: "failing-model",
          protocol: "openai-chat-v1",
        },
        {
          id: "backup",
          provider: "fixture",
          model: "local-backup",
          protocol: "openai-chat-v1",
        },
      ],
    },
  };
  return { gateway, calls, options, presetRegistry };
}

describe("role routing policy", () => {
  it.each(["text", "object", "stream"] as const)(
    "preserves role fallback and resolves its local binding for %s",
    async (mode) => {
      const { gateway, calls, options, presetRegistry } = setup();
      const input = {
        presetId: "utility",
        messages: [{ role: "user" as const, content: "hello" }],
      };
      if (mode === "text") await gateway.generateText(input, options);
      else if (mode === "object")
        await gateway.generateObject(
          { ...input, schema: z.object({ ok: z.boolean() }) },
          options,
        );
      else
        for await (const _event of gateway.streamText(input, options)) {
          /* consume */
        }
      expect(calls).toEqual(["failing-model", "local-backup"]);
      expect(presetRegistry.listPresets().map((p) => p.model)).toEqual([
        "base-story",
        "base-utility",
        "jev-latest",
      ]);
    },
  );

  it("honors allowFallback=false after overriding the role model", async () => {
    const { gateway, calls, options } = setup();
    await expect(
      gateway.generateText(
        { presetId: "utility", messages: [] },
        { ...options, allowFallback: false },
      ),
    ).rejects.toThrow("Synthetic failure");
    expect(calls).toEqual(["failing-model"]);
  });

  it("rejects an evaluation model assigned to a text role before I/O", async () => {
    const { gateway, calls } = setup();
    await expect(
      gateway.generateText(
        { presetId: "story", messages: [] },
        {
          slotOverrides: {
            slotBindings: { story: { presetId: "slot-intent" } },
          },
        },
      ),
    ).rejects.toThrow('cannot serve role "story"');
    expect(calls).toEqual([]);
  });

  it("supports evaluation as a capability on arbitrary role names", () => {
    const { gateway } = setup();
    const result = gateway.resolveSlot("npc-choice", {
      fallbackTag: "evaluation",
      slotOverrides: {
        slotBindings: { "npc-choice": { presetId: "slot-intent" } },
      },
    });
    expect(result).toMatchObject({ model: "jev-latest", tag: "evaluation" });
  });
});
