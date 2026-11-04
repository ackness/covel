// @vitest-environment node
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

function navigation(options: { developerMode?: boolean } = {}) {
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
  return buildNavTree(store, { locale: "en-US", ...options });
}

it("routes current composite settings and plugin groups to their panes", () => {
  const tree = navigation();
  expect(resolveSettingsNode(tree, "keys.custom")?.id).toBe("llm.providers");
  expect(resolveSettingsNode(tree, "llm.paramOverrides")?.id).toBe(
    "llm.advanced",
  );
  // Capability overrides belong to developer mode.
  expect(resolveSettingsNode(tree, "llm.capabilityOverrides")).toBeUndefined();
  expect(resolveSettingsNode(tree, "trust.sources")?.id).toBe("packages");
  expect(resolveSettingsNode(tree, "group.general")?.id).toBe("general");
  expect(resolveSettingsNode(tree, "ui.appearance")?.id).toBe("appearance");
  expect(resolveSettingsNode(tree, "plugin")?.id).toBe("packages");
  expect(resolveSettingsNode(tree, "ui.onboardedVersion")).toBeUndefined();
});

it("searches custom pane entries and excludes the internal onboarding revision from General", () => {
  const tree = navigation();
  expect(
    filterNav(tree, "Parameter overrides", "en-US").map((node) => node.id),
  ).toContain("llm.advanced");
  expect(
    filterNav(
      navigation({ developerMode: true }),
      "llm.capabilityOverrides",
      "en-US",
    ).map((node) => node.id),
  ).toContain("llm.slots");
  expect(
    tree.flatMap((node) => node.children.map((entry) => entry.key)),
  ).not.toContain("ui.onboardedVersion");
});

it("F-079 does not offer custom widgets as inert General settings", () => {
  const general = navigation().find((node) => node.id === "general");
  expect(general?.children.length).toBeGreaterThan(0);
  expect(general?.children.some((entry) => entry.widget === "custom")).toBe(
    false,
  );
  expect(general?.children.map((entry) => entry.key)).not.toContain(
    "media.allowedImageHosts",
  );
});

it("groups settings into General, Models, Plugins, Saves & data and Advanced", () => {
  const tree = navigation();
  expect(
    tree.filter((node) => node.kind === "header").map((node) => node.label),
  ).toEqual(["General", "Models", "Plugins", "Saves & data", "Advanced"]);
  const keysOf = (id: string) =>
    tree.find((node) => node.id === id)?.children.map((entry) => entry.key);
  expect(keysOf("general")).toEqual([
    "ui.locale",
    "audio.musicEnabled",
    "audio.musicVolume",
    "ui.instantText",
    "ui.liveOutput",
    "ui.expandTurnUpdates",
  ]);
  expect(keysOf("advanced")).toEqual([
    "ui.developerView",
    "diagnostics.traceRetention",
    "ui.chatMessageWindow",
    "world.authoringIdleTimeoutSeconds",
  ]);
  // Every setting has one pane.
  const owners = tree.flatMap((node) =>
    node.children.map((entry) => entry.key),
  );
  expect(new Set(owners).size).toBe(owners.length);
});

it("keeps trusted sources only under Plugins and the raw configuration under Advanced", () => {
  const tree = navigation();
  expect(
    tree.filter((node) => node.parentId === "group.advanced").map((n) => n.id),
  ).toEqual(["advanced", "raw-config", "operator-access"]);
  expect(tree.find((node) => node.id === "packages")?.parentId).toBe("plugin");
  expect(
    tree
      .flatMap((n) => n.children.map((e) => e.key))
      .filter((k) => k === "trust.sources"),
  ).toHaveLength(1);
});

it("shows capability overrides only in developer mode", () => {
  const keys = (developerMode: boolean) =>
    navigation({ developerMode })
      .find((node) => node.id === "llm.slots")
      ?.children.map((entry) => entry.key);
  expect(keys(false)).toEqual(["llm.slotConfig"]);
  expect(keys(true)).toEqual(["llm.slotConfig", "llm.capabilityOverrides"]);
});
