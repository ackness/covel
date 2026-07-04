import { describe, it, expect, vi, afterEach } from "vitest";
import { createGateway } from "../src/gateway.js";
import { createPresetRegistry } from "../src/preset-registry.js";
import { createProviderRegistry } from "../src/provider-registry.js";
import { registerImageWire } from "../src/image/wire-registry.js";
import type { ImageWire } from "../src/image/types.js";
import type { ModelProfile, PresetConfig } from "../src/types.js";
import type { ModelProviderAdapter } from "../src/adapters/adapter.js";

// ── Stub adapter (unused by generateImage — the wire bypasses it — but
// provider-registry.resolve() still requires one to be registered) ────

function createStubAdapter(): ModelProviderAdapter {
  return {
    async generateText() {
      return {
        text: "stub",
        finishReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
    async generateObject<TObject>() {
      return {
        object: {} as TObject,
        finishReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
    async *streamText() {},
    async embed() {
      return { embeddings: [[]], usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
}

const profiles: ModelProfile[] = [
  {
    id: "image-tier",
    tier: "image-tier",
    provider: "test",
    model: "test-image-model",
    contextWindow: 4096,
    latencyClass: "medium",
    costClass: "low",
    supportedModes: ["image"],
  },
];

function setup(presetOverrides: Partial<PresetConfig> = {}) {
  const providerRegistry = createProviderRegistry({
    providers: {
      test: {
        adapter: createStubAdapter(),
        defaults: { baseUrl: "https://x.test", apiKey: "k" },
      },
    },
  });
  const presets: PresetConfig[] = [
    {
      id: "img-primary",
      name: "Image Primary",
      provider: "test",
      model: "test-image-model",
      tier: "image-tier",
      supportedModes: ["image"],
      enabled: true,
      ...presetOverrides,
    },
  ];
  const presetRegistry = createPresetRegistry({ profiles, presets });
  const gateway = createGateway({ providerRegistry, presetRegistry });
  return { gateway };
}

function mockFetchOnce(status: number, json: unknown) {
  const fn = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Bad Request",
    text: async () => JSON.stringify(json),
  })) as unknown as typeof fetch;
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

// >= 64 chars, %4===0 — the openai-images wire treats shorter strings as
// non-image bare base64 and drops them.
const PNG_B64 = Buffer.from(
  "fakepngbytes-fakepngbytes-fakepngbytes-fakepngbytes-fakepng0000",
).toString("base64");

describe("gateway.generateImage", () => {
  it("dispatches to the default openai-images wire", async () => {
    const fn = mockFetchOnce(200, {
      data: [{ b64_json: PNG_B64 }],
    });
    const { gateway } = setup();

    const result = await gateway.generateImage({
      presetId: "img-primary",
      prompt: "a cat",
    });

    expect(fn).toHaveBeenCalledWith(
      "https://x.test/v1/images/generations",
      expect.objectContaining({ method: "POST" }),
    );
    expect(result.images).toHaveLength(1);
    expect(result.model).toBe("test-image-model");
    expect(result.provider).toBe("test");
  });

  it("merges slot providerRequestMetadata into the wire call, stripping the imageWire routing key", async () => {
    const fn = mockFetchOnce(200, { data: [{ b64_json: PNG_B64 }] });
    const { gateway } = setup({
      providerRequestMetadata: { imageWire: "openai-images", style: "vivid" },
    });

    await gateway.generateImage({ presetId: "img-primary", prompt: "a cat" });

    const body = JSON.parse(
      (fn.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body.style).toBe("vivid");
    expect(body).not.toHaveProperty("imageWire");
  });

  it("dispatches to a custom wire named via preset providerRequestMetadata.imageWire", async () => {
    const customWire: ImageWire = {
      id: "gateway-test-custom-wire",
      generate: async () => ({
        images: [
          {
            kind: "url",
            url: "https://cdn.test/custom.png",
            mime: "image/png",
          },
        ],
        usage: null,
        warnings: ["custom wire used"],
      }),
    };
    registerImageWire(customWire);

    const { gateway } = setup({
      providerRequestMetadata: { imageWire: "gateway-test-custom-wire" },
    });

    const result = await gateway.generateImage({
      presetId: "img-primary",
      prompt: "a dog",
    });

    expect(result.images).toEqual([
      { kind: "url", url: "https://cdn.test/custom.png", mime: "image/png" },
    ]);
    expect(result.warnings).toEqual(["custom wire used"]);
  });

  it("throws a clear error for an unregistered imageWire id", async () => {
    const { gateway } = setup({
      providerRequestMetadata: { imageWire: "ghost" },
    });

    await expect(
      gateway.generateImage({ presetId: "img-primary", prompt: "a fox" }),
    ).rejects.toThrow(/unknown image wire "ghost"/);
  });

  it("does not silently route to the default text slot when presetId is omitted", async () => {
    // Harness has a default text preset and a separate image preset. Before
    // the `?? "image"` default, an omitted presetId resolved to the default
    // (text) preset and silently succeeded against the text provider; now it
    // enters the named-slot chain and fails loudly when no "image" slot or
    // image-tagged fallback exists.
    mockFetchOnce(200, { data: [{ b64_json: PNG_B64 }] });
    const providerRegistry = createProviderRegistry({
      providers: {
        test: {
          adapter: createStubAdapter(),
          defaults: { baseUrl: "https://x.test", apiKey: "k" },
        },
      },
    });
    const presetRegistry = createPresetRegistry({
      profiles,
      presets: [
        {
          id: "story",
          name: "Story",
          provider: "test",
          model: "test-text-model",
          tier: "image-tier",
          supportedModes: ["text"],
          enabled: true,
          isDefault: true,
        },
        {
          id: "img-primary",
          name: "Image Primary",
          provider: "test",
          model: "test-image-model",
          tier: "image-tier",
          supportedModes: ["image"],
          enabled: true,
        },
      ],
    });
    const gateway = createGateway({ providerRegistry, presetRegistry });

    await expect(gateway.generateImage({ prompt: "a cat" })).rejects.toThrow(
      /image/,
    );
  });
});
