import { describe, it, expect, vi, afterEach } from "vitest";
import { createGateway } from "../src/gateway.js";
import { createPresetRegistry } from "../src/preset-registry.js";
import { createProviderRegistry } from "../src/provider-registry.js";
import { createSlotRegistry } from "../src/slot-registry.js";
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
  const slotRegistry = createSlotRegistry({ presetRegistry });
  const gateway = createGateway({
    providerRegistry,
    presetRegistry,
    slotRegistry,
  });
  return { gateway, slotRegistry, presetRegistry, providerRegistry };
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
  it("classifies a missing provider as an image configuration error before any request", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { gateway } = setup({ provider: "unregistered-image-provider" });
    expect(() =>
      gateway.resolveSlot("img-primary", { fallbackTag: "image" }),
    ).toThrow(
      expect.objectContaining({
        code: "CONFIG_ERROR",
        retriable: false,
        message: expect.stringContaining('"img-primary"'),
      }),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("propagates unexpected provider resolution failures", () => {
    const { gateway, providerRegistry } = setup();
    const failure = new Error("unexpected provider registry failure");
    vi.spyOn(providerRegistry, "resolve").mockImplementation(() => {
      throw failure;
    });
    expect(() =>
      gateway.resolveSlot("img-primary", { fallbackTag: "image" }),
    ).toThrow(failure);
  });

  it("allows an image endpoint without an API key", () => {
    const { gateway, providerRegistry } = setup();
    providerRegistry.reconfigure({
      providers: {
        test: {
          adapter: createStubAdapter(),
          defaults: { baseUrl: "https://images.test" },
        },
      },
    });
    expect(
      gateway.resolveSlot("img-primary", { fallbackTag: "image" }),
    ).toMatchObject({
      model: "test-image-model",
      baseUrl: "https://images.test",
    });
  });

  it("propagates unexpected resolution failures instead of classifying them as configuration errors", async () => {
    const { gateway, presetRegistry } = setup();
    const failure = new Error("unexpected registry failure");
    vi.spyOn(presetRegistry, "resolveTextTarget").mockImplementation(() => {
      throw failure;
    });
    await expect(
      gateway.generateImage({ presetId: "img-primary", prompt: "a cat" }),
    ).rejects.toBe(failure);
    expect(() =>
      gateway.resolveSlot("img-primary", { fallbackTag: "image" }),
    ).toThrow(failure);
  });

  it("returns the dispatched identity even when configuration changes while the wire runs", async () => {
    const { gateway, presetRegistry } = setup({
      providerRequestMetadata: { imageWire: "identity-test", style: "vivid" },
      embeddingFormat: "openai",
    });
    const expected = gateway.resolveSlot("img-primary", {
      fallbackTag: "image",
    })!;
    const dispose = registerImageWire({
      id: "identity-test",
      generate: async () => {
        presetRegistry.reconfigure({ profiles, presets: [] });
        return { images: [], warnings: [], usage: null };
      },
    });
    try {
      const result = await gateway.generateImage({
        presetId: "img-primary",
        prompt: "a cat",
      });
      expect(result.target).toEqual({
        provider: expected.provider,
        model: expected.model,
        protocol: expected.protocol,
        baseUrl: expected.baseUrl,
        metadata: expected.metadata,
      });
      expect(result.target).not.toHaveProperty("apiKey");
      expect(result.target).not.toHaveProperty("headers");
    } finally {
      dispose();
    }
  });

  it("uses the configured image role for generation and slot inspection", async () => {
    const fn = mockFetchOnce(200, { data: [{ b64_json: PNG_B64 }] });
    const { gateway, slotRegistry } = setup();
    slotRegistry.configure({
      slots: {
        image: { slotId: "image", presetId: "img-primary", tag: "image" },
      },
    });

    expect(
      gateway.resolveSlot(undefined, { fallbackTag: "image" }),
    ).toMatchObject({
      presetId: "img-primary",
      model: "test-image-model",
    });
    await expect(
      gateway.generateImage({ prompt: "a cat" }),
    ).resolves.toMatchObject({
      model: "test-image-model",
    });
    expect(fn).toHaveBeenCalledOnce();
  });

  it.each([undefined, "image-typo"])(
    "rejects missing image role %s instead of using another image slot",
    async (presetId) => {
      const fn = mockFetchOnce(200, { data: [{ b64_json: PNG_B64 }] });
      const { gateway, slotRegistry } = setup();
      slotRegistry.configure({
        slots: {
          alternate: {
            slotId: "alternate",
            presetId: "img-primary",
            tag: "image",
          },
        },
      });
      const expected = {
        code: "CONFIG_ERROR",
        message: expect.stringContaining(`"${presetId ?? "image"}"`),
      };
      await expect(
        gateway.generateImage({ presetId, prompt: "a cat" }),
      ).rejects.toMatchObject(expected);
      expect(() =>
        gateway.resolveSlot(presetId, { fallbackTag: "image" }),
      ).toThrow(expect.objectContaining(expected));
      expect(fn).not.toHaveBeenCalled();
    },
  );

  it.each(["server", "request"])(
    "rejects an image role bound to a text model through %s configuration",
    async (source) => {
      const fn = mockFetchOnce(200, { data: [{ b64_json: PNG_B64 }] });
      const { gateway, slotRegistry } = setup({ supportedModes: ["text"] });
      slotRegistry.configure({
        slots: {
          image: { slotId: "image", presetId: "img-primary", tag: "image" },
        },
      });
      const options =
        source === "request"
          ? {
              slotOverrides: {
                slotBindings: { image: { presetId: "img-primary" } },
              },
            }
          : {};
      await expect(
        gateway.generateImage({ prompt: "a cat" }, options),
      ).rejects.toMatchObject({
        code: "CONFIG_ERROR",
        message: expect.stringContaining('role "image"'),
      });
      expect(() =>
        gateway.resolveSlot(undefined, { ...options, fallbackTag: "image" }),
      ).toThrow(/image-capable/);
      expect(fn).not.toHaveBeenCalled();
    },
  );

  it("honors request image bindings without persisting the binding", async () => {
    const fn = mockFetchOnce(200, { data: [{ b64_json: PNG_B64 }] });
    const { gateway } = setup();
    const options = {
      slotOverrides: { slotBindings: { image: { presetId: "img-primary" } } },
    };
    expect(
      gateway.resolveSlot(undefined, { ...options, fallbackTag: "image" })
        ?.model,
    ).toBe("test-image-model");
    await expect(
      gateway.generateImage({ prompt: "a cat" }, options),
    ).resolves.toMatchObject({ model: "test-image-model" });
    await expect(
      gateway.generateImage({ prompt: "a cat" }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
    expect(fn).toHaveBeenCalledOnce();
  });

  it("applies capability policy to request-scoped custom image models", async () => {
    const fn = mockFetchOnce(200, { data: [{ b64_json: PNG_B64 }] });
    const { gateway, presetRegistry } = setup();
    const slotOverrides = {
      customPresets: [
        {
          id: "custom-image",
          name: "Custom Image",
          provider: "test",
          model: "custom-image-model",
        },
      ],
      slotBindings: { image: { modelRef: "custom-image" } },
      capabilityOverrides: { image: { output: ["image"] } },
    };
    await expect(
      gateway.generateImage({ prompt: "a cat" }, { slotOverrides }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
    expect(fn).not.toHaveBeenCalled();
    const options = {
      slotOverrides,
      capabilityOverridePolicy: "full" as const,
    };
    expect(
      gateway.resolveSlot(undefined, { ...options, fallbackTag: "image" }),
    ).toMatchObject({
      presetId: "custom-image",
      capability: { output: ["image"] },
    });
    await expect(
      gateway.generateImage({ prompt: "a cat" }, options),
    ).resolves.toMatchObject({ model: "custom-image-model" });
    expect(fn).toHaveBeenCalledOnce();
    expect(presetRegistry.hasPreset("custom-image")).toBe(false);
  });

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
    // image role default, an omitted presetId resolved to the default
    // (text) preset. The image preset requires an explicit role binding.
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
