import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatSlotLabel, useSlotConfig } from "@/hooks/use-slot-config.js";

const modelSettings = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  slotConfig: {} as Record<string, { presetId?: string; modelRef?: string }>,
  customPresets: [] as Array<{
    id: string;
    name: string;
    provider: string;
    baseUrl: string;
    model: string;
  }>,
}));

vi.mock("@/settings/use-settings.js", () => ({
  useSetting: <T,>(key: string): [T, (value: T) => Promise<void>] => [
    modelSettings.values.get(key) as T,
    vi.fn(async () => undefined),
  ],
}));

vi.mock("@/services/api.js", () => ({
  getSlotConfig: () => modelSettings.slotConfig,
  getCustomPresets: () => modelSettings.customPresets,
  slotBindingId: (
    entry: { presetId?: string; modelRef?: string } | null | undefined,
  ) => entry?.modelRef ?? entry?.presetId,
}));

function preset(id: string, provider: string, model: string) {
  return { id, name: model, provider, baseUrl: "", model };
}

beforeEach(() => {
  modelSettings.values.clear();
  modelSettings.slotConfig = { default: { modelRef: "model-a" } };
  modelSettings.customPresets = [preset("model-a", "openai", "gpt-old")];
  modelSettings.values.set("llm.slotConfig", modelSettings.slotConfig);
  modelSettings.values.set("llm.providers", [{ id: "openai" }]);
  modelSettings.values.set("llm.customPresets", undefined);
});

describe("useSlotConfig", () => {
  it("updates a displayed provider/model when provider settings change", () => {
    const { result, rerender } = renderHook(() => useSlotConfig([]));
    expect(formatSlotLabel(result.current.resolvedSlots[0])).toBe(
      "openai · gpt-old",
    );

    modelSettings.customPresets = [preset("model-a", "openai", "gpt-new")];
    modelSettings.values.set("llm.providers", [{ id: "openai", revision: 2 }]);
    rerender();

    expect(formatSlotLabel(result.current.resolvedSlots[0])).toBe(
      "openai · gpt-new",
    );
  });

  it("updates the displayed model when a slot binding changes", () => {
    modelSettings.customPresets = [
      preset("model-a", "openai", "gpt-old"),
      preset("model-b", "anthropic", "claude-new"),
    ];
    const { result, rerender } = renderHook(() => useSlotConfig([]));
    expect(formatSlotLabel(result.current.resolvedSlots[0])).toBe(
      "openai · gpt-old",
    );

    modelSettings.slotConfig = { default: { modelRef: "model-b" } };
    modelSettings.values.set("llm.slotConfig", modelSettings.slotConfig);
    rerender();

    expect(formatSlotLabel(result.current.resolvedSlots[0])).toBe(
      "anthropic · claude-new",
    );
  });
});
