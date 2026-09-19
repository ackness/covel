import { beforeEach, expect, it } from "vitest";
import { SettingsStore } from "@covel/settings";
import i18n from "@/i18n";
import { registerCoreSettings } from "../registry/core.js";
import { registerLlmSettings } from "../registry/llm.js";
import { registerPluginUserSettings } from "../registry/plugin.js";
import { buildNavTree, filterNav, resolveSettingsNode } from "../navigation.js";

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
});

function navigation() {
  const store = new SettingsStore({
    load: async () => ({}),
    save: async () => undefined,
    loadSecrets: async () => ({}),
    saveSecrets: async () => undefined,
  });
  registerCoreSettings(store);
  registerLlmSettings(store);
  registerPluginUserSettings(store, "fixture", [
    { key: "voice", type: "slot", label: "Voice model", default: "audio" },
  ]);
  return buildNavTree(store, { locale: "en-US" });
}

it("routes current composite settings and plugin groups to their panes", () => {
  const tree = navigation();
  expect(resolveSettingsNode(tree, "keys.custom")?.id).toBe("llm.providers");
  expect(resolveSettingsNode(tree, "llm.paramOverrides")?.id).toBe(
    "llm.advanced",
  );
  expect(resolveSettingsNode(tree, "llm.capabilityOverrides")?.id).toBe(
    "llm.slots",
  );
  expect(resolveSettingsNode(tree, "ui.appearance")?.id).toBe("appearance");
  expect(resolveSettingsNode(tree, "plugin")?.id).toBe("plugin.fixture");
  expect(resolveSettingsNode(tree, "ui.onboardedVersion")).toBeUndefined();
});

it("searches custom pane entries and excludes the internal onboarding revision from General", () => {
  const tree = navigation();
  expect(
    filterNav(tree, "Parameter overrides", "en-US").map((node) => node.id),
  ).toContain("llm.advanced");
  expect(
    filterNav(tree, "llm.capabilityOverrides", "en-US").map((node) => node.id),
  ).toContain("llm.slots");
  expect(
    tree
      .find((node) => node.id === "general")
      ?.children.map((entry) => entry.key),
  ).not.toContain("ui.onboardedVersion");
});
