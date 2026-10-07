// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { ResolvedSlot } from "@/hooks/use-slot-config.js";
import { boundTextSlots } from "../model-state.js";

const server: ResolvedSlot = {
  slotId: "story",
  presetId: "",
  preset: null,
  tag: "text",
  label: "story",
  serverModel: "server-model",
  hasCredentials: true,
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
  it("keeps server and client bindings available for review without credentials", () => {
    expect(
      boundTextSlots([server, { ...local, hasCredentials: false }]),
    ).toEqual([server, { ...local, hasCredentials: false }]);
  });
  it("does not describe image, disabled, missing or unresolved bindings as configured text models", () => {
    expect(
      boundTextSlots([
        { ...server, tag: "image" },
        { ...server, serverModel: "" },
        { ...local, preset: null },
        { ...local, preset: { ...local.preset!, enabled: false } },
      ]),
    ).toEqual([]);
  });
});
