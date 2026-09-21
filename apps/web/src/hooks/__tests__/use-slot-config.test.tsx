import i18n from "@/i18n/index.js";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  effectiveSlotModel,
  formatSlotBindingLabel,
  formatSlotLabel,
  useSlotConfig,
} from "@/hooks/use-slot-config.js";

const modelSettings = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  slotConfig: {} as Record<string, { presetId?: string; modelRef?: string }>,
  customPresets: [] as Array<{
    id: string;
    name: string;
    provider: string;
    baseUrl: string;
    model: string;
    protocol?: string;
    reasoningEffort?: "disabled" | "automatic";
  }>,
}));

vi.mock("@/settings/use-settings.js", () => ({
  useSetting: <T,>(key: string): [T, (value: T) => Promise<void>] => [
    modelSettings.values.get(key) as T,
    vi.fn(async () => undefined),
  ],
}));

vi.mock("@/services/api.js", () => ({
  lookupModelCapabilityDetails: vi.fn(async () => {
    throw new Error("No catalogue in this fixture");
  }),
  getSlotConfig: () => modelSettings.slotConfig,
  getCustomPresets: () => modelSettings.customPresets,
  slotBindingId: (
    entry: { presetId?: string; modelRef?: string } | null | undefined,
  ) => entry?.modelRef ?? entry?.presetId,
}));

function preset(id: string, provider: string, model: string) {
  return { id, name: model, provider, baseUrl: "", model };
}

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  modelSettings.values.clear();
  modelSettings.slotConfig = { default: { modelRef: "model-a" } };
  modelSettings.customPresets = [preset("model-a", "openai", "gpt-old")];
  modelSettings.values.set("llm.slotConfig", modelSettings.slotConfig);
  modelSettings.values.set("llm.providers", [{ id: "openai" }]);
});

describe("useSlotConfig", () => {
  it("does not advertise server defaults for an unresolved explicit local model", () => {
    modelSettings.slotConfig = { story: { modelRef: "missing" } };
    modelSettings.customPresets = [];
    modelSettings.values.set("llm.slotConfig", modelSettings.slotConfig);
    const server = {
      ...preset("missing", "server", "server-model"),
      enabled: true,
      isDefault: true,
      scope: "server",
    };
    const { result } = renderHook(() =>
      useSlotConfig([server], {
        configured: true,
        providers: ["server"],
        slots: {
          story: {
            provider: "server",
            model: "server-model",
            protocol: "openai-chat-v1",
            tag: "text",
            parameterOverrides: { reasoningEffort: "high" },
          },
        },
      }),
    );
    expect(result.current.resolveSlot("story")).toBeNull();
    const slot = result.current.resolvedSlots[0]!;
    expect(effectiveSlotModel(slot)).toBeUndefined();
    expect(slot.serverProvider).toBeUndefined();
    expect(slot.reasoningEffort).toBeUndefined();
    expect(result.current.slotConfig.story).toEqual({ modelRef: "missing" });
  });

  it("resolves same-named local and server choices using their explicit namespace", () => {
    modelSettings.slotConfig = {
      story: { modelRef: "shared" },
      memory: { presetId: "shared" },
    };
    modelSettings.customPresets = [preset("shared", "local", "local-model")];
    modelSettings.values.set("llm.slotConfig", modelSettings.slotConfig);
    const server = {
      ...preset("shared", "server", "server-model"),
      enabled: true,
      isDefault: true,
      scope: "server",
    };
    const { result } = renderHook(() => useSlotConfig([server]));
    expect(result.current.resolveSlot("story")?.model).toBe("local-model");
    expect(result.current.resolveSlot("memory")?.model).toBe("server-model");
    expect(
      result.current.resolvedSlots.map((slot) => slot.preset?.model),
    ).toEqual(["local-model", "server-model"]);
  });

  it("labels shared model variants and reacts to role overrides without changing the API ID", () => {
    modelSettings.customPresets = [
      {
        ...preset("model-a", "fixture", "qwen3.8-flash"),
        name: "Story",
        reasoningEffort: "automatic",
      },
    ];
    const { result, rerender } = renderHook(() => useSlotConfig([]));
    expect(formatSlotBindingLabel(result.current.resolvedSlots[0]!)).toBe(
      "default · Story · Thinking on",
    );
    expect(effectiveSlotModel(result.current.resolvedSlots[0])).toBe(
      "qwen3.8-flash",
    );
    modelSettings.values.set("llm.paramOverrides", {
      default: { reasoningEffort: "disabled" },
    });
    rerender();
    expect(formatSlotLabel(result.current.resolvedSlots[0])).toBe(
      "fixture · Story · Thinking off",
    );
    expect(result.current.allPresets[0]!.reasoningEffort).toBe("automatic");
  });

  it("uses the client override in runtime-binding labels", () => {
    const slot = {
      slotId: "plugin",
      presetId: "model-a",
      preset: {
        ...preset("model-a", "ali-coding-plan", "qwen3.8-flash"),
        enabled: true,
        isDefault: false,
        scope: "custom" as const,
      },
      label: "plugin",
      tag: "text",
      serverModel: "deepseek-v4-flash",
      serverProvider: "deepseek",
    };

    expect(effectiveSlotModel(slot)).toBe("qwen3.8-flash");
    expect(formatSlotBindingLabel(slot)).toBe("plugin · qwen3.8-flash");
  });

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

describe("role capability classification", () => {
  it("classifies arbitrary evaluation roles and excludes incompatible core bindings", () => {
    modelSettings.slotConfig = {
      "npc-choice": { modelRef: "judge" },
      story: { modelRef: "judge" },
    };
    modelSettings.customPresets = [
      {
        ...preset("judge", "openrouter", "typesafe/jev-1.13"),
        protocol: "openrouter-decisions-v1",
      },
    ];
    modelSettings.values.set("llm.slotConfig", modelSettings.slotConfig);
    const { result } = renderHook(() => useSlotConfig([]));
    expect(result.current.resolvedSlots).toEqual([
      expect.objectContaining({
        slotId: "npc-choice",
        tag: "evaluation",
        isAvailable: true,
      }),
      expect.objectContaining({
        slotId: "story",
        tag: "text",
        isAvailable: false,
      }),
    ]);
  });
});
