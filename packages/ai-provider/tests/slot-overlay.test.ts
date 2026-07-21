import { describe, it, expect, beforeEach } from "vitest";
import {
  createPresetRegistry,
  createProviderRegistry,
  applySlotOverlay,
  publicPresetId,
  resolveOverlayPresetId,
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

/** Map a public preset id through a request's own overrides to its scoped id. */
function scopedId(
  deps: ReturnType<typeof makeDeps>,
  id: string,
  overrides: SlotOverridesInput,
): string | undefined {
  return resolveOverlayPresetId(id, overrides, (k) =>
    deps.presetRegistry.hasPreset(k),
  );
}

describe("applySlotOverlay", () => {
  beforeEach(() => {
    // Isolate the module-level ref counter between tests so a leak in one
    // case doesn't mask or amplify a bug in another.
    __internals.presetRefs.clear();
  });

  it("registers a custom preset under a request-scoped id, then cleans up", () => {
    const deps = makeDeps();
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

    // Never registered under the bare public id (that's the poisoning
    // surface) and no provider is ever registered.
    expect(deps.presetRegistry.hasPreset("custom_abc")).toBe(false);
    expect(deps.providerRegistry.hasProvider("vendorX")).toBe(false);

    // The request's own overrides map to the scoped registration.
    const key = scopedId(deps, "custom_abc", overrides);
    expect(key).toBeDefined();
    expect(key).not.toBe("custom_abc");
    expect(publicPresetId(key!)).toBe("custom_abc");
    expect(deps.presetRegistry.resolvePreset(key!)).toMatchObject({
      id: key,
      provider: "vendorX",
      model: "fast-7b",
      baseUrl: "https://api.vendorx.example/v1",
      protocol: "openai-chat-v1",
      requestScoped: true,
    });

    cleanup();

    expect(deps.presetRegistry.hasPreset(key!)).toBe(false);
    // With the registration gone the mapping falls back to the public id.
    expect(scopedId(deps, "custom_abc", overrides)).toBe("custom_abc");
    expect(__internals.presetRefs.size).toBe(0);
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
    const overrides: SlotOverridesInput = {
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
    };
    const cleanup = applySlotOverlay(deps, overrides);

    // Base wins: no overlay registration, resolution keeps the public id.
    expect(scopedId(deps, "ds-chat", overrides)).toBe("ds-chat");
    const preset = deps.presetRegistry.resolvePreset("ds-chat");
    expect(preset?.model).toBe("deepseek-chat");
    expect(preset?.baseUrl).not.toBe("https://evil.example");

    cleanup();

    // And still there after cleanup — we never owned it.
    expect(deps.presetRegistry.hasPreset("ds-chat")).toBe(true);
  });

  it("isolates concurrent same-id presets with different baseUrls", () => {
    const deps = makeDeps();
    const mk = (baseUrl: string): SlotOverridesInput => ({
      customPresets: [
        {
          id: "custom_shared",
          name: "Shared",
          provider: "openai",
          baseUrl,
          model: "gpt-x",
          protocol: "openai-chat-v1",
        },
      ],
    });
    const attacker = mk("https://attacker.example");
    const victim = mk("https://api.openai.example/v1");

    // Interleaved: attacker applies first and stays alive while the victim
    // request runs.
    const cleanupAttacker = applySlotOverlay(deps, attacker);
    const cleanupVictim = applySlotOverlay(deps, victim);

    const attackerId = scopedId(deps, "custom_shared", attacker);
    const victimId = scopedId(deps, "custom_shared", victim);
    expect(attackerId).not.toBe(victimId);

    // Each request resolves ITS OWN baseUrl — never the other's.
    expect(deps.presetRegistry.resolvePreset(attackerId!)?.baseUrl).toBe(
      "https://attacker.example",
    );
    expect(deps.presetRegistry.resolvePreset(victimId!)?.baseUrl).toBe(
      "https://api.openai.example/v1",
    );

    cleanupAttacker();
    // Victim's registration survives the attacker's rollback untouched.
    expect(deps.presetRegistry.hasPreset(attackerId!)).toBe(false);
    expect(deps.presetRegistry.resolvePreset(victimId!)?.baseUrl).toBe(
      "https://api.openai.example/v1",
    );

    cleanupVictim();
    expect(deps.presetRegistry.hasPreset(victimId!)).toBe(false);
    expect(__internals.presetRefs.size).toBe(0);
  });

  it("reference-counts identical configs; cleanup removes only at zero", () => {
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
    const key = scopedId(deps, "custom_shared", overrides)!;
    // Identical (id, config) → one shared registration, two refs.
    expect(deps.presetRegistry.hasPreset(key)).toBe(true);
    expect(__internals.presetRefs.get(key)).toBe(2);

    cleanupA();
    // Still alive — B is still holding a ref.
    expect(deps.presetRegistry.hasPreset(key)).toBe(true);
    expect(__internals.presetRefs.get(key)).toBe(1);

    cleanupB();
    // Last ref released → gone.
    expect(deps.presetRegistry.hasPreset(key)).toBe(false);
    expect(__internals.presetRefs.size).toBe(0);
  });

  it("calling cleanup twice is idempotent", () => {
    const deps = makeDeps();
    const overrides: SlotOverridesInput = {
      customPresets: [
        {
          id: "custom_once",
          name: "Once",
          provider: "onceProv",
          baseUrl: "https://once.example",
          model: "once-m",
        },
      ],
    };
    const cleanup = applySlotOverlay(deps, overrides);

    cleanup();
    cleanup(); // must not throw or underflow the ref count
    expect(__internals.presetRefs.size).toBe(0);
    expect(scopedId(deps, "custom_once", overrides)).toBe("custom_once");
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
    expect(__internals.presetRefs.size).toBe(0);
    expect(deps.presetRegistry.listPresets().map((p) => p.id)).toEqual([
      "ds-chat",
    ]);
  });

  it("degrades to no-op when the registry surface lacks overlay methods", () => {
    // Simulate a structural mock lacking hasPreset / addPreset etc.
    const stubDeps = {
      presetRegistry: {
        resolveTextTarget: () => ({ profile: null, preset: null }),
        resolveEmbeddingTarget: () => ({ profile: null, preset: null }),
        resolveTextTargetChain: () => [],
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

describe("resolveOverlayPresetId", () => {
  it("returns the input unchanged without overrides or hasPreset", () => {
    expect(resolveOverlayPresetId("x", undefined, () => true)).toBe("x");
    expect(resolveOverlayPresetId("x", { customPresets: [] }, () => true)).toBe(
      "x",
    );
    expect(
      resolveOverlayPresetId(
        "x",
        { customPresets: [{ id: "x", name: "X", provider: "p", model: "m" }] },
        undefined,
      ),
    ).toBe("x");
    expect(resolveOverlayPresetId(undefined, undefined, () => true)).toBe(
      undefined,
    );
  });
});

describe("publicPresetId", () => {
  it("is the identity for plain preset ids", () => {
    expect(publicPresetId("ds-chat")).toBe("ds-chat");
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
