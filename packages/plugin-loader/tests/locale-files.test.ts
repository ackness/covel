import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPluginDefinition } from "../src/load.js";
import { setTranslationsDirectory } from "../src/locale-files.js";
import type { PluginDiscoveryResult } from "../src/types.js";

/**
 * A translation can come from outside the plugin package: a translation
 * package the user installed, or a machine translation made on the user's
 * machine. Both are files in the translations directory, in the format of
 * the plugin's own `locales/<locale>.yaml`.
 */
describe("translations made outside the plugin package", () => {
  let home: string;
  let root: string;
  let translations: string;

  const PLUGIN = `---
id: demo
kind: plugin
displayName: Inventory
description: Keeps the player character's bag.
provides: [narrative-engine@1]
runtime:
  type: agent
  schedule: {stage: narrative}
  io: {output: {contract: narrative-engine@1}}
  agent: {tools: {builtin: [plugin-data-set]}}
---
English prompt body.
`;

  const write = async (file: string, content: string) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  };
  const load = () =>
    loadPluginDefinition({
      id: "demo",
      rootPath: root,
      pluginMdPaths: [path.join(root, "PLUGIN.md")],
      isMultiRuntime: false,
    } as PluginDiscoveryResult);

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "covel-translations-"));
    // A plugin's id is the name of its directory.
    root = path.join(home, "plugins", "demo");
    translations = path.join(home, "translations");
    await write(path.join(root, "PLUGIN.md"), PLUGIN);
    setTranslationsDirectory(translations);
  });
  afterEach(async () => {
    setTranslationsDirectory(undefined);
    await fs.rm(home, { recursive: true, force: true });
  });

  it("translates a plugin that ships no translation of its own", async () => {
    await write(
      path.join(translations, "plugins/demo/ja.yaml"),
      "PLUGIN.md:\n  displayName: 持ち物\nmessages:\n  Bag is empty.: かばんは空です。\n",
    );
    const definition = await load();

    expect(definition.packageManifest.plugin.displayName).toEqual({
      en: "Inventory",
      ja: "持ち物",
    });
    expect(definition.messages).toEqual([
      {
        locale: "ja",
        file: "translations/demo/ja.yaml",
        messages: { "Bag is empty.": "かばんは空です。" },
      },
    ]);
  });

  it("fills only what the author's file does not translate", async () => {
    await write(
      path.join(root, "locales/zh.yaml"),
      "PLUGIN.md:\n  displayName: 行囊\nmessages:\n  Bag is empty.: 行囊是空的。\n",
    );
    await write(
      path.join(translations, "plugins/demo/zh.yaml"),
      [
        "PLUGIN.md:",
        "  displayName: 背包",
        "  description: 保管玩家角色的背包。",
        "messages:",
        "  Bag is empty.: 背包空了。",
        "  Bag is full.: 背包满了。",
        "",
      ].join("\n"),
    );
    const definition = await load();
    const { plugin } = definition.packageManifest;

    expect(plugin.displayName).toEqual({ en: "Inventory", zh: "行囊" });
    expect(plugin.description).toEqual({
      en: "Keeps the player character's bag.",
      zh: "保管玩家角色的背包。",
    });
    expect(definition.messages).toEqual([
      {
        locale: "zh",
        file: "locales/zh.yaml",
        messages: {
          "Bag is empty.": "行囊是空的。",
          "Bag is full.": "背包满了。",
        },
      },
    ]);
  });

  it("reads the translations of this plugin only", async () => {
    await write(
      path.join(translations, "plugins/other/zh.yaml"),
      "PLUGIN.md:\n  displayName: 别的插件\n",
    );
    expect((await load()).packageManifest.plugin.displayName).toBe("Inventory");
  });

  it("reads nothing when no directory is set", async () => {
    await write(
      path.join(translations, "plugins/demo/zh.yaml"),
      "PLUGIN.md:\n  displayName: 背包\n",
    );
    setTranslationsDirectory(undefined);
    expect((await load()).packageManifest.plugin.displayName).toBe("Inventory");
  });
});
