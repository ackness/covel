import { describe, expect, it } from "vitest";

import {
  autoBindDiscoveredSlots,
  collectLlmSlotPresetCandidates,
  createVisibleSlotIds,
  discoverRuntimeSlotIds,
} from "../llm-slots-model.js";

describe("llm slots model", () => {
  it("discovers runtime and user-setting slot ids without default text slots", () => {
    const slots = discoverRuntimeSlotIds([
      {
        runtimes: [
          {
            id: "runtime-image",
            kind: "agent",
            trigger: { type: "auto" },
            model: "image",
          },
          {
            id: "runtime-plugin",
            kind: "agent",
            trigger: { type: "auto" },
            model: "plugin",
          },
          {
            id: "runtime-text",
            kind: "agent",
            trigger: { type: "auto" },
            model: "text",
          },
          {
            id: "runtime-function",
            kind: "function",
            trigger: { type: "auto" },
            model: "ignored-function-slot",
          },
        ],
        userSettings: [
          {
            key: "modelPresetId",
            type: "select",
            default: "image-fast",
            label: "Model",
          },
          {
            key: "modelPresetId",
            type: "select",
            default: "default",
            label: "Default",
          },
        ],
      },
    ]);

    expect(slots).toEqual(["image", "image-fast", "plugin"]);
  });

  it("merges configured or default slots with discovered slots", () => {
    expect(
      createVisibleSlotIds({
        isConfigured: true,
        configuredSlots: ["story", "default", "image"],
        discoveredSlotIds: ["image", "plugin"],
      }),
    ).toEqual(["story", "image", "plugin"]);

    expect(
      createVisibleSlotIds({
        isConfigured: false,
        configuredSlots: [],
        discoveredSlotIds: ["vector"],
      }),
    ).toEqual([
      "story",
      "plugin",
      "memory",
      "image",
      "fast",
      "balance",
      "vector",
    ]);
  });

  it("auto-binds discovered slots by preset id before provider name", () => {
    const next = autoBindDiscoveredSlots(
      { plugin: { presetId: "existing" } },
      ["plugin", "image", "vector"],
      [
        { id: "image", provider: "other" },
        { id: "slot-vector", provider: "not-vector" },
        { id: "provider-vector", provider: "vector" },
      ],
    );

    expect(next).toEqual({
      plugin: { presetId: "existing" },
      image: { presetId: "image" },
      vector: { presetId: "slot-vector" },
    });
  });

  it("marks collected presets with their source", () => {
    expect(
      collectLlmSlotPresetCandidates(
        [{ id: "builtin", name: "Built-in", provider: "openai", model: "gpt" }],
        [{ id: "custom", name: "Custom", provider: "local", model: "m" }],
      ),
    ).toEqual([
      {
        id: "builtin",
        name: "Built-in",
        provider: "openai",
        model: "gpt",
        isCustom: false,
      },
      {
        id: "custom",
        name: "Custom",
        provider: "local",
        model: "m",
        isCustom: true,
      },
    ]);
  });
});
