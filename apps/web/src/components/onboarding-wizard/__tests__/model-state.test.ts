import { describe, expect, it } from "vitest";
import type { ResolvedSlot } from "@/hooks/use-slot-config.js";
import { configuredTextSlots } from "../model-state.js";

const server: ResolvedSlot = {
  slotId: "story",
  presetId: "",
  preset: null,
  tag: "text",
  label: "story",
  serverModel: "server-model",
};
const local: ResolvedSlot = {
  ...server,
  slotId: "plugin",
  presetId: "local-model",
  preset: {
    id: "local-model",
    name: "Local",
    provider: "fixture",
    model: "text-model",
    enabled: true,
    isDefault: false,
    scope: "custom",
  },
};

describe("onboarding model detection", () => {
  it("accepts server and canonical client bindings without requiring another key", () => {
    expect(configuredTextSlots([server, local])).toEqual([server, local]);
  });
  it("does not describe image, disabled, missing or unresolved bindings as configured text models", () => {
    expect(
      configuredTextSlots([
        { ...server, tag: "image" },
        { ...server, serverModel: "" },
        { ...local, preset: null },
        { ...local, preset: { ...local.preset!, enabled: false } },
      ]),
    ).toEqual([]);
  });
});
