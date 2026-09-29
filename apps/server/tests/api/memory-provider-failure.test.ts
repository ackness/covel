import { afterEach, expect, it, vi } from "vitest";
import {
  createGateway,
  createOpenAiResponsesAdapter,
  createPresetRegistry,
  createProviderRegistry,
} from "@covel/ai-provider";
import { createPluginRuntimeGateway } from "@covel/runtime";
import extract from "../../../../plugins/memory/server/extract.js";

afterEach(() => vi.unstubAllGlobals());

it("does not write memory or report provider success from a failed non-stream response", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            status: "failed",
            error: { code: "server_error", message: "Synthetic failure" },
            output: [
              {
                type: "message",
                content: [
                  {
                    type: "output_text",
                    text: '{"scene":"Partial uncommitted scene"}',
                  },
                ],
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        ),
    ),
  );
  const success = vi.fn();
  const error = vi.fn();
  const write = vi.fn();
  const providerRegistry = createProviderRegistry({
    providers: {
      synthetic: {
        adapter: createOpenAiResponsesAdapter(),
        defaults: { baseUrl: "https://provider.example" },
        hooks: [{ onRequestSuccess: success, onRequestError: error }],
      },
    },
  });
  const presetRegistry = createPresetRegistry({
    profiles: [],
    presets: [
      {
        id: "memory",
        name: "Synthetic",
        provider: "synthetic",
        model: "synthetic",
        tier: "medium",
        supportedModes: ["text"],
        enabled: true,
        isDefault: true,
      },
    ],
  });
  const gateway = createPluginRuntimeGateway(
    createGateway({ providerRegistry, presetRegistry }),
  );
  await expect(
    extract({
      inputs: {
        turn: {
          value: {
            narrativeText: "A committed narrative.",
            toolCallSummaries: [],
          },
        },
      },
      locale: "en",
      signal: new AbortController().signal,
      gateway,
      world: { characters: [], characterSchema: null },
      pluginData: { get: async () => null, list: async () => [], set: write },
    }),
  ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  expect(write).not.toHaveBeenCalled();
  expect(success).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalledTimes(3);
});
