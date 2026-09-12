import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { SettingsStore } from "@covel/settings";
import type { PluginSummary } from "@covel/shared";
import i18n from "@/i18n";
import { registerPluginUserSettings } from "@/settings/registry/plugin.js";
import { PluginPackageRow } from "../plugin-package-row.js";

const mocks = vi.hoisted(() => ({ store: null as unknown as SettingsStore }));
vi.mock("@/settings/store.js", () => ({ getSettings: () => mocks.store }));
const plugin: PluginSummary = {
  id: "fixture",
  displayName: "Current plugin",
  description: "Current metadata",
  pluginType: "plugin",
  source: "builtin",
  status: "registered",
  runtimeCount: 2,
  capabilities: [],
  tags: [],
  tools: [],
  runtimes: ["narrative", "post-turn"].map((stage, index) => ({
    id: `fixture/agent-${index}`,
    stage: stage as "narrative" | "post-turn",
    model: "removed-role",
    runtimeType: "agent",
    execution: "sync",
    trigger: { type: "auto" },
    turnCompletion: { mode: "await" },
    outputKind: "plugin",
    capabilities: [],
    tags: [],
  })),
  userSettings: [
    {
      key: "imageRole",
      type: "slot",
      label: "Image role",
      default: "old-image",
    },
    { key: "voiceRole", type: "slot", label: "Voice role", default: "voice" },
  ],
};
const slots = ["story", "image", "voice"].map((id) => ({
  slotId: id,
  label: id,
  presetId: "",
  preset: null,
  tag: id === "story" ? "text" : "image",
  serverModel: `${id}-model`,
}));
const setBinding = vi.fn();
function rowProps(binding = "story") {
  return {
    pkg: plugin,
    pluginPlan: null,
    activePluginPack: null,
    selectedPluginIdSet: new Set([plugin.id]),
    corePluginIds: new Set<string>(),
    lockedPluginIds: new Set<string>(),
    resolvedSlots: slots,
    resolveDeclaredSlot: (id: string) =>
      slots.find((slot) => slot.slotId === id) ?? null,
    isMissingDeclaredSlot: (id: string) =>
      !slots.some((slot) => slot.slotId === id),
    onTogglePlugin: vi.fn(),
    worldPluginSettings: { fixture: { imageRole: "image" } },
    bindingState: {
      entries: plugin.runtimes.map((runtime) => ({
        pluginId: plugin.id,
        qualifiedId: runtime.id,
        defaultSlot: "removed-role",
        slotName: binding,
      })),
      bindings: {},
      allBound: true,
      setBinding,
      autoAssign: vi.fn(),
      compatibleSlots: () => slots,
    },
  };
}
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  mocks.store = new SettingsStore({
    load: async () => ({}),
    save: async () => undefined,
    loadSecrets: async () => ({}),
    saveSecrets: async () => undefined,
  });
  registerPluginUserSettings(mocks.store, plugin.id, plugin.userSettings);
  await mocks.store.init();
  setBinding.mockClear();
});
it("shows all stages and provider settings, respecting world defaults and player overrides", async () => {
  render(<PluginPackageRow {...rowProps()} />);
  expect(screen.getByText("Narrative")).toBeTruthy();
  expect(screen.getByText("Post-Turn")).toBeTruthy();
  expect(screen.getByRole("combobox", { name: "Image role" })).toBeTruthy();
  expect(screen.getByRole("combobox", { name: "Voice role" })).toBeTruthy();
  expect(screen.queryByRole("status")).toBeNull();
  await act(async () => {
    await mocks.store.set("plugin.fixture.imageRole", "voice");
  });
  expect(
    (screen.getByRole("combobox", { name: "Image role" }) as HTMLSelectElement)
      .value,
  ).toBe("voice");
});
it("warns about the effective binding, then clears warnings when the missing default is overridden", () => {
  const view = render(<PluginPackageRow {...rowProps("")} />);
  expect(screen.getAllByRole("status")).toHaveLength(2);
  view.rerender(<PluginPackageRow {...rowProps()} />);
  expect(screen.queryByRole("status")).toBeNull();
  const runtime = screen.getByRole("combobox", {
    name: "Model · fixture/agent-0",
  }) as HTMLSelectElement;
  expect(Array.from(runtime.options).map((option) => option.value)).toEqual([
    "",
    "story",
  ]);
  fireEvent.change(runtime, { target: { value: "" } });
  expect(setBinding).toHaveBeenCalledWith("fixture/agent-0", "");
});
