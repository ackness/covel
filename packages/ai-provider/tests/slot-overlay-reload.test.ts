import { describe, expect, it } from "vitest";
import { createPresetRegistry } from "../src/preset-registry.js";
import {
  applySlotOverlay,
  resolveOverlayPresetId,
} from "../src/slot-overlay.js";
import type { SlotOverridesInput } from "../src/types.js";

const overrides: SlotOverridesInput = {
  customPresets: [
    {
      id: "custom",
      provider: "deepseek",
      model: "deepseek-chat",
      protocol: "openai-chat-v1",
    },
  ],
};
function setup() {
  const presetRegistry = createPresetRegistry({ profiles: [], presets: [] });
  return {
    presetRegistry,
    resolved: () =>
      presetRegistry.resolvePreset(
        resolveOverlayPresetId("custom", overrides, presetRegistry.hasPreset),
      ),
  };
}

describe("overlay registry lifecycle", () => {
  it("isolates identical overlapping presets in separate registries", () => {
    const first = setup();
    const second = setup();
    const disposeFirst = applySlotOverlay(first, overrides);
    const disposeSecond = applySlotOverlay(second, overrides);
    try {
      expect(first.resolved()?.model).toBe("deepseek-chat");
      expect(second.resolved()?.model).toBe("deepseek-chat");
      disposeFirst();
      expect(first.presetRegistry.listPresets()).toEqual([]);
      expect(second.resolved()?.model).toBe("deepseek-chat");
    } finally {
      disposeFirst();
      disposeSecond();
    }
    expect(second.presetRegistry.listPresets()).toEqual([]);
  });

  it.each(["old", "new"])(
    "restores an overlay after reload when the %s request finishes first",
    (firstToFinish) => {
      const deps = setup();
      const disposeOld = applySlotOverlay(deps, overrides);
      deps.presetRegistry.reconfigure({ profiles: [], presets: [] });
      const disposeNew = applySlotOverlay(deps, overrides);
      try {
        expect(deps.resolved()?.model).toBe("deepseek-chat");
        (firstToFinish === "old" ? disposeOld : disposeNew)();
        expect(deps.resolved()?.model).toBe("deepseek-chat");
      } finally {
        disposeOld();
        disposeNew();
      }
      expect(deps.presetRegistry.listPresets()).toEqual([]);
    },
  );

  it("prefers a newly registered base preset over an older active overlay", () => {
    const deps = setup();
    const dispose = applySlotOverlay(deps, overrides);
    const overlay = deps.resolved()!;
    deps.presetRegistry.addPreset({
      ...overlay,
      id: "custom",
      model: "trusted-model",
      requestScoped: false,
    });
    try {
      expect(deps.resolved()?.model).toBe("trusted-model");
    } finally {
      dispose();
    }
    expect(deps.resolved()?.model).toBe("trusted-model");
  });
});
