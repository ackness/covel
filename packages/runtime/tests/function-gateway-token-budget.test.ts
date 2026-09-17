import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAnthropicMessagesAdapter,
  createGateway,
  createPresetRegistry,
  createProviderRegistry,
} from "@covel/ai-provider";
import { createPluginRuntimeGateway } from "../src/function-runtime/plugin-runtime-gateway.js";

afterEach(() => vi.unstubAllGlobals());

describe("function plugin output budget", () => {
  it.each([
    [262_144, undefined, 16_384],
    [undefined, undefined, 16_384],
    [8192, undefined, 8192],
    [65_536, 32_768, 32_768],
    [8192, 2048, 2048],
  ])(
    "serializes capacity %s and request %s as %s tokens",
    async (capacity, requested, expected) => {
      const fetch = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              content: [{ type: "text", text: "ok" }],
              stop_reason: "end_turn",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      );
      vi.stubGlobal("fetch", fetch);
      const presetRegistry = createPresetRegistry({
        profiles: [],
        presets: [
          {
            id: "fast",
            name: "Synthetic fast",
            provider: "fixture",
            model: "synthetic-model",
            tier: "medium",
            supportedModes: ["text"],
            enabled: true,
            capability: {
              contextWindow: 131_072,
              ...(capacity === undefined ? {} : { maxOutputTokens: capacity }),
            },
          },
        ],
      });
      const providerRegistry = createProviderRegistry({
        providers: {
          fixture: {
            adapter: createAnthropicMessagesAdapter(),
            defaults: {
              baseUrl: "https://fixture.example",
              protocol: "anthropic-messages-v1",
            },
          },
        },
      });
      const gateway = createPluginRuntimeGateway(
        createGateway({ presetRegistry, providerRegistry }),
        requested === undefined
          ? {}
          : {
              slotOverrides: {
                parameterOverrides: { fast: { maxOutputTokens: requested } },
              },
            },
      );
      await gateway.generateText({
        presetId: "fast",
        prompt: "Synthetic rewrite",
      });
      const init = (
        fetch.mock.calls as unknown as Array<[string, RequestInit]>
      )[0]![1];
      expect(JSON.parse(init.body as string).max_tokens).toBe(expected);
    },
  );
});
