import { describe, it, expect, beforeEach } from "vitest";
import {
  createPresetRegistry,
  createProviderRegistry,
  applySlotOverlay,
  resolveSlotOverride,
  type SlotOverridesInput,
} from "../src/index.js";
import { __internals } from "../src/slot-overlay.js";

function makeDeps() {
  const providerRegistry = createProviderRegistry({
    providerDefaults: {
      deepseek: {
        baseUrl: "https://api.deepseek.com",
        protocol: "openai-chat-v1",
      },
    },
  });
  const presetRegistry = createPresetRegistry({
    profiles: [],
    presets: [
      {
        id: "ds-chat",
        name: "DeepSeek Chat",
        provider: "deepseek",
        model: "deepseek-chat",
        protocol: "openai-chat-v1",
        tier: "medium",
        supportedModes: ["text", "stream"],
        enabled: true,
        tag: "text",
      },
    ],
  });
  return { providerRegistry, presetRegistry };
}

describe("applySlotOverlay", () => {
  beforeEach(() => {
    // Isolate the module-level ref counters between tests so a leak in one
    // case doesn't mask or amplify a bug in another.
    __internals.presetRefs.clear();
    __internals.providerRefs.clear();
  });

  it("registers a custom preset and provider, then cleans up", () => {
    const deps = makeDeps();
    expect(deps.providerRegistry.hasProvider("vendorX")).toBe(false);
    expect(deps.presetRegistry.hasPreset("custom_abc")).toBe(false);

    const overrides: SlotOverridesInput = {
      customPresets: [
        {
          id: "custom_abc",
          name: "Vendor X Fast",
          provider: "vendorX",
          baseUrl: "https://api.vendorx.example/v1",
          model: "fast-7b",
          protocol: "openai-chat-v1",
        },
      ],
    };

    const cleanup = applySlotOverlay(deps, overrides);

    expect(deps.providerRegistry.hasProvider("vendorX")).toBe(true);
    expect(deps.presetRegistry.hasPreset("custom_abc")).toBe(true);
    const preset = deps.presetRegistry.resolvePreset("custom_abc");
    expect(preset).toMatchObject({
      id: "custom_abc",
      provider: "vendorX",
      model: "fast-7b",
      baseUrl: "https://api.vendorx.example/v1",
      protocol: "openai-chat-v1",
    });

    cleanup();

    expect(deps.providerRegistry.hasProvider("vendorX")).toBe(false);
    expect(deps.presetRegistry.hasPreset("custom_abc")).toBe(false);
  });

  it("is a no-op when overrides are undefined or empty", () => {
    const deps = makeDeps();
    expect(applySlotOverlay(deps, undefined)).toBeInstanceOf(Function);
    expect(applySlotOverlay(deps, {})).toBeInstanceOf(Function);
    expect(applySlotOverlay(deps, { customPresets: [] })).toBeInstanceOf(
      Function,
    );
    // Still works after the no-op cleanup — doesn't touch registries.
    expect(deps.presetRegistry.listPresets().map((p) => p.id)).toEqual([
      "ds-chat",
    ]);
  });

  it("never overwrites an entry already present in the base registry", () => {
    const deps = makeDeps();
    const cleanup = applySlotOverlay(deps, {
      customPresets: [
        {
          id: "ds-chat", // collides with base preset
          name: "Hijack",
          provider: "deepseek",
          baseUrl: "https://evil.example",
          model: "hijack-model",
          protocol: "openai-chat-v1",
        },
      ],
    });

    const preset = deps.presetRegistry.resolvePreset("ds-chat");
    expect(preset?.model).toBe("deepseek-chat"); // base wins
    expect(preset?.baseUrl).not.toBe("https://evil.example");

    cleanup();

    // And still there after cleanup — we never owned it.
    expect(deps.presetRegistry.hasPreset("ds-chat")).toBe(true);
  });

  it("reference-counts concurrent applies; cleanup removes only at zero", () => {
    const deps = makeDeps();
    const overrides: SlotOverridesInput = {
      customPresets: [
        {
          id: "custom_shared",
          name: "Shared",
          provider: "sharedProvider",
          baseUrl: "https://shared.example",
          model: "shared-m",
          protocol: "openai-chat-v1",
        },
      ],
    };

    const cleanupA = applySlotOverlay(deps, overrides);
    const cleanupB = applySlotOverlay(deps, overrides);
    // Both callers see the overlay.
    expect(deps.presetRegistry.hasPreset("custom_shared")).toBe(true);
    expect(deps.providerRegistry.hasProvider("sharedProvider")).toBe(true);
    expect(__internals.presetRefs.get("custom_shared")).toBe(2);
    expect(__internals.providerRefs.get("sharedProvider")).toBe(2);

    cleanupA();
    // Still alive — B is still holding a ref.
    expect(deps.presetRegistry.hasPreset("custom_shared")).toBe(true);
    expect(deps.providerRegistry.hasProvider("sharedProvider")).toBe(true);
    expect(__internals.presetRefs.get("custom_shared")).toBe(1);

    cleanupB();
    // Last ref released → gone.
    expect(deps.presetRegistry.hasPreset("custom_shared")).toBe(false);
    expect(deps.providerRegistry.hasProvider("sharedProvider")).toBe(false);
    expect(__internals.presetRefs.has("custom_shared")).toBe(false);
    expect(__internals.providerRefs.has("sharedProvider")).toBe(false);
  });

  it("calling cleanup twice is idempotent", () => {
    const deps = makeDeps();
    const cleanup = applySlotOverlay(deps, {
      customPresets: [
        {
          id: "custom_once",
          name: "Once",
          provider: "onceProv",
          baseUrl: "https://once.example",
          model: "once-m",
        },
      ],
    });

    cleanup();
    cleanup(); // must not throw or underflow the ref count
    expect(__internals.presetRefs.has("custom_once")).toBe(false);
    expect(__internals.providerRefs.has("onceProv")).toBe(false);
  });

  it("skips malformed custom preset entries", () => {
    const deps = makeDeps();
    const cleanup = applySlotOverlay(deps, {
      customPresets: [
        // Missing provider
        {
          id: "bad_1",
          name: "Bad",
          provider: "",
          model: "m",
        },
        // Missing model
        {
          id: "bad_2",
          name: "Bad",
          provider: "p",
          model: "",
        },
        // Missing id
        {
          id: "",
          name: "Bad",
          provider: "p",
          model: "m",
        },
      ],
    });
    cleanup();
    expect(deps.presetRegistry.hasPreset("bad_1")).toBe(false);
    expect(deps.presetRegistry.hasPreset("bad_2")).toBe(false);
  });

  it("degrades to no-op when the registry surface lacks overlay methods", () => {
    // Simulate a structural mock lacking hasPreset / addPreset etc.
    const stubDeps = {
      presetRegistry: {
        resolveTextTarget: () => ({ profile: null, preset: null }),
        resolveEmbeddingTarget: () => ({ profile: null, preset: null }),
        resolveTextTargetChain: () => [],
      },
      providerRegistry: {
        resolve: () => {
          throw new Error("unused");
        },
        withApiKeys: (r: unknown) => r,
      },
    } as unknown as Parameters<typeof applySlotOverlay>[0];
    const cleanup = applySlotOverlay(stubDeps, {
      customPresets: [
        {
          id: "x",
          name: "X",
          provider: "p",
          model: "m",
          baseUrl: "https://x.example",
        },
      ],
    });
    // Must not throw, must return a callable cleanup.
    expect(typeof cleanup).toBe("function");
    cleanup();
  });
});

describe("resolveSlotOverride", () => {
  it("returns the override when slotPresetOverrides has the key", () => {
    expect(
      resolveSlotOverride("fast", {
        slotPresetOverrides: { fast: "custom_abc" },
      }),
    ).toBe("custom_abc");
  });

  it("returns the input unchanged when no override matches", () => {
    expect(
      resolveSlotOverride("story", {
        slotPresetOverrides: { fast: "custom_abc" },
      }),
    ).toBe("story");
  });

  it("returns the input unchanged when overrides are undefined", () => {
    expect(resolveSlotOverride("story", undefined)).toBe("story");
  });

  it("ignores empty-string overrides", () => {
    expect(
      resolveSlotOverride("fast", {
        slotPresetOverrides: { fast: "" },
      }),
    ).toBe("fast");
  });
});
