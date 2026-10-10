/**
 * A request with images that falls back to the next model of the chain: a
 * model that reads no image gets the text only, and the size check for the
 * fallback does not count image bytes as text.
 */

import { describe, expect, it, vi } from "vitest";
import { createGateway } from "../src/gateway.js";
import { createPresetRegistry } from "../src/preset-registry.js";
import { createProviderRegistry } from "../src/provider-registry.js";
import type { ModelProviderAdapter } from "../src/adapters/adapter.js";
import type {
  ModelCapability,
  ModelProfile,
  PresetConfig,
  TextMessage,
} from "../src/types.js";

const profile: ModelProfile = {
  id: "medium",
  tier: "medium",
  provider: "test",
  model: "vision-model",
  contextWindow: 64_000,
  latencyClass: "medium",
  costClass: "low",
  supportedModes: ["text", "object", "stream"],
};

const vision: ModelCapability = { input: ["text", "image"], output: ["text"] };
const textOnly: ModelCapability = { input: ["text"], output: ["text"] };

function preset(
  id: string,
  model: string,
  capability: ModelCapability | undefined,
  fallbackPresetIds?: string[],
): PresetConfig {
  return {
    id,
    name: id,
    provider: id === "primary" ? "test" : "backup-provider",
    model,
    tier: "medium",
    supportedModes: ["text", "object", "stream"],
    enabled: true,
    ...(id === "primary" ? { isDefault: true } : {}),
    ...(capability ? { capability } : {}),
    ...(fallbackPresetIds ? { fallbackPresetIds } : {}),
  };
}

// About 1.3 MB of base64: as text it would be far over the 64k window.
const picture = "A".repeat(1_300_000);
const messages: TextMessage[] = [
  { role: "system", content: "You narrate." },
  {
    role: "user",
    content: [
      { type: "text", text: "Picture 1: the relay at dusk" },
      { type: "image", image: picture, mediaType: "image/png" },
    ],
  },
  {
    role: "user",
    content: [{ type: "image", image: picture, mediaType: "image/png" }],
  },
  { role: "user", content: "Go on." },
];

function setup(
  primaryCapability: ModelCapability | undefined,
  backupCapability: ModelCapability | undefined,
) {
  const seen: Array<{ model: string; messages: readonly TextMessage[] }> = [];
  const record = (params: { model: string; messages: TextMessage[] }) => {
    seen.push({ model: params.model, messages: params.messages });
    if (params.model === "vision-model") throw new Error("Upstream down");
  };
  const adapter: ModelProviderAdapter = {
    generateText: vi.fn(async (_config, params) => {
      record(params);
      return {
        text: "ok",
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    }),
    generateObject: vi.fn(),
    async *streamText(_config, params) {
      record(params);
      yield { type: "text-delta" as const, textDelta: "ok" };
      yield {
        type: "done" as const,
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
    embed: vi.fn(),
  };
  const gateway = createGateway({
    providerRegistry: createProviderRegistry({
      providers: {
        test: { adapter, defaults: { baseUrl: "https://test.api" } },
        "backup-provider": {
          adapter,
          defaults: { baseUrl: "https://backup.api" },
        },
      },
    }),
    presetRegistry: createPresetRegistry({
      profiles: [profile],
      presets: [
        preset("primary", "vision-model", primaryCapability, ["backup"]),
        preset("backup", "backup-model", backupCapability),
      ],
    }),
  });
  return { gateway, seen };
}

const textOnlyMessages = [
  { role: "system", content: "You narrate." },
  {
    role: "user",
    content: [{ type: "text", text: "Picture 1: the relay at dusk" }],
  },
  { role: "user", content: [{ type: "text", text: "[image]" }] },
  { role: "user", content: "Go on." },
];

describe("images across a text fallback chain", () => {
  it.each(["generateText", "streamText"] as const)(
    "%s sends a fallback model that reads no image the text only",
    async (method) => {
      const { gateway, seen } = setup(vision, textOnly);
      if (method === "generateText") {
        const result = await gateway.generateText({ messages });
        expect(result.model).toBe("backup-model");
      } else {
        await Array.fromAsync(gateway.streamText({ messages }));
      }
      expect(seen.map((call) => call.model)).toEqual([
        "vision-model",
        "backup-model",
      ]);
      // The model the caller checked gets the request as it was made.
      expect(seen[0]?.messages).toBe(messages);
      expect(seen[1]?.messages).toEqual(textOnlyMessages);
    },
  );

  it("keeps the images for a fallback model that reads them", async () => {
    const { gateway, seen } = setup(vision, vision);
    await gateway.generateText({ messages });
    expect(seen[1]?.model).toBe("backup-model");
    expect(seen[1]?.messages).toBe(messages);
  });

  it("leaves the request alone when the first model is not known to read images", async () => {
    // The caller sent them on its own judgement, not on a declared capability.
    const { gateway, seen } = setup(undefined, undefined);
    await gateway.generateText({
      messages: [messages[1]!, { role: "user", content: "Go on." }],
    });
    expect(seen[1]?.messages[0]).toBe(messages[1]);
  });
});
