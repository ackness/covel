import { describe, it, expect } from "vitest";
import { resolveRuntimeBinding, generateDefaultBindings } from "../src/binding-resolver.js";
import type { SlotRegistry } from "@covel/ai-provider";
import type { RuntimeBindingMap, RuntimeBindingInfo } from "../src/types.js";

/**
 * Mock slot registry matching user's real llm.toml:
 *   ds   → deepseek-chat (text)
 *   qwen → qwen3.6-plus  (text)
 *   fast → qwen3.5-flash (text)
 *   free → nemotron      (text)
 */
function makeSlotRegistry(): SlotRegistry {
  const slots: Record<string, { slotId: string; presetId: string; tag: string }> = {
    ds: { slotId: "ds", presetId: "slot-ds", tag: "text" },
    qwen: { slotId: "qwen", presetId: "slot-qwen", tag: "text" },
    fast: { slotId: "fast", presetId: "slot-fast", tag: "text" },
    free: { slotId: "free", presetId: "slot-free", tag: "text" },
  };

  return {
    configure: () => {},
    resolveSlot: (id: string) => slots[id]?.presetId,
    listSlotsByTag: (tag: string) => Object.values(slots).filter((s) => s.tag === tag),
    getSlotTag: (id: string) => slots[id]?.tag,
    getParameterOverrides: () => undefined,
    listSlots: () => slots,
  };
}

/** Registry with an image slot added */
function makeSlotRegistryWithImage(): SlotRegistry {
  const base = makeSlotRegistry();
  const slots = {
    ...base.listSlots(),
    dalle: { slotId: "dalle", presetId: "slot-dalle", tag: "image" },
  };
  return {
    ...base,
    resolveSlot: (id: string) => slots[id]?.presetId,
    listSlotsByTag: (tag: string) => Object.values(slots).filter((s) => s.tag === tag),
    getSlotTag: (id: string) => slots[id]?.tag,
    listSlots: () => slots,
  };
}

describe("resolveRuntimeBinding", () => {
  const registry = makeSlotRegistry();

  it("should resolve a valid text binding", () => {
    const bindings: RuntimeBindingMap = { "core-narrator:narrator": "ds" };
    const result = resolveRuntimeBinding(
      "core-narrator:narrator",
      "text",
      bindings,
      registry,
    );
    expect(result).toEqual({ presetId: "slot-ds", slotName: "ds" });
  });

  it("should resolve different runtimes to different slots", () => {
    const bindings: RuntimeBindingMap = {
      "core-narrator:narrator": "ds",
      "core-quest:quest-tracker": "fast",
    };
    const r1 = resolveRuntimeBinding("core-narrator:narrator", "text", bindings, registry);
    const r2 = resolveRuntimeBinding("core-quest:quest-tracker", "text", bindings, registry);
    expect(r1?.presetId).toBe("slot-ds");
    expect(r2?.presetId).toBe("slot-fast");
  });

  it("should return null when runtime has no binding", () => {
    const bindings: RuntimeBindingMap = {};
    const result = resolveRuntimeBinding(
      "core-narrator:narrator",
      "text",
      bindings,
      registry,
    );
    expect(result).toBeNull();
  });

  it("should return null when bound slot does not exist", () => {
    const bindings: RuntimeBindingMap = { "core-narrator:narrator": "nonexistent" };
    const result = resolveRuntimeBinding(
      "core-narrator:narrator",
      "text",
      bindings,
      registry,
    );
    expect(result).toBeNull();
  });

  it("should return null when tag is incompatible (text runtime bound to image slot)", () => {
    const registryWithImage = makeSlotRegistryWithImage();
    const bindings: RuntimeBindingMap = { "core-narrator:narrator": "dalle" };
    const result = resolveRuntimeBinding(
      "core-narrator:narrator",
      "text",
      bindings,
      registryWithImage,
    );
    expect(result).toBeNull();
  });

  it("should return null when tag is incompatible (image runtime bound to text slot)", () => {
    const bindings: RuntimeBindingMap = { "core-image:image-generator": "ds" };
    const result = resolveRuntimeBinding(
      "core-image:image-generator",
      "image",
      bindings,
      registry,
    );
    expect(result).toBeNull();
  });

  it("should resolve image runtime to image slot", () => {
    const registryWithImage = makeSlotRegistryWithImage();
    const bindings: RuntimeBindingMap = { "core-image:image-generator": "dalle" };
    const result = resolveRuntimeBinding(
      "core-image:image-generator",
      "image",
      bindings,
      registryWithImage,
    );
    expect(result).toEqual({ presetId: "slot-dalle", slotName: "dalle" });
  });
});

describe("generateDefaultBindings", () => {
  const registry = makeSlotRegistry();

  it("should assign first compatible slot to each runtime", () => {
    const runtimes: RuntimeBindingInfo[] = [
      { qualifiedId: "core-narrator:narrator", providerTag: "text" },
      { qualifiedId: "core-quest:quest-tracker", providerTag: "text" },
    ];
    const bindings = generateDefaultBindings(runtimes, registry);
    // First text slot is "ds"
    expect(bindings["core-narrator:narrator"]).toBe("ds");
    expect(bindings["core-quest:quest-tracker"]).toBe("ds");
  });

  it("should assign image slot to image runtime", () => {
    const registryWithImage = makeSlotRegistryWithImage();
    const runtimes: RuntimeBindingInfo[] = [
      { qualifiedId: "core-narrator:narrator", providerTag: "text" },
      { qualifiedId: "core-image:image-generator", providerTag: "image" },
    ];
    const bindings = generateDefaultBindings(runtimes, registryWithImage);
    expect(bindings["core-narrator:narrator"]).toBe("ds");
    expect(bindings["core-image:image-generator"]).toBe("dalle");
  });

  it("should skip runtimes with no compatible slot", () => {
    const runtimes: RuntimeBindingInfo[] = [
      { qualifiedId: "core-narrator:narrator", providerTag: "text" },
      { qualifiedId: "core-image:image-generator", providerTag: "image" },
    ];
    // registry has no image slots
    const bindings = generateDefaultBindings(runtimes, registry);
    expect(bindings["core-narrator:narrator"]).toBe("ds");
    expect(bindings["core-image:image-generator"]).toBeUndefined();
  });

  it("should return empty map for empty runtime list", () => {
    const bindings = generateDefaultBindings([], registry);
    expect(bindings).toEqual({});
  });
});
