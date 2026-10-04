import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validatePluginLabels } from "../src/locale-labels.js";
import {
  lockPluginLabels,
  pluginLabelUnits,
  pluginTranslationStatus,
  writePluginTranslations,
} from "../src/locale-tooling.js";

/**
 * What a translator of a plugin needs to know: what exists, what a language
 * lacks, and which label translations belong to an English text that has
 * changed since.
 */
describe("plugin translation tooling", () => {
  let dir: string;
  const write = async (file: string, content: string) => {
    await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await fs.writeFile(path.join(dir, file), content);
  };
  const manifest = (description: string) => `---
id: demo
kind: plugin
displayName: Inventory
description: ${description}
contributes:
  commands:
    - name: bag
      description: Open the bag.
      action: open-bag
  actions: [open-bag]
  data:
    items:
      version: 1
      description: Importable items, read by world authors.
      authoring:
        title: Starting items
  prompt:
    - id: post-history
      content: Call the tool once.
      position: post-history
      role: system
---
`;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "covel-tooling-"));
    await write("PLUGIN.md", manifest("Keeps the bag."));
    await write(
      "ui/panel.json",
      JSON.stringify({ label: "Bag", emptyState: { message: "Empty." } }),
    );
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("lists the labels a player reads, with their places", async () => {
    expect(
      (await pluginLabelUnits(dir)).map((unit) => [unit.pointer, unit.text]),
    ).toEqual([
      ["displayName", "Inventory"],
      ["description", "Keeps the bag."],
      ["contributes.commands[name=bag].description", "Open the bag."],
      // A data namespace's own description is for world authors; the prompt
      // segment is an instruction. Neither is a label.
      ["contributes.data.items.authoring.title", "Starting items"],
    ]);
  });

  it("reports what a language lacks", async () => {
    await write(
      "locales/zh.yaml",
      "PLUGIN.md:\n  displayName: 行囊\nmessages:\n  Bag: 背包\n",
    );
    const status = await pluginTranslationStatus(dir, "zh");

    expect(status.labels.total).toBe(4);
    expect(status.labels.missing.map((unit) => unit.pointer)).toEqual([
      "description",
      "contributes.commands[name=bag].description",
      "contributes.data.items.authoring.title",
    ]);
    expect(status.messages.total).toBe(2);
    expect(status.messages.missing.map((item) => item.text)).toEqual([
      "Empty.",
    ]);
  });

  it("writes translations at their places and keeps what was there", async () => {
    await write(
      "locales/zh.yaml",
      "# Checked by a person.\nPLUGIN.md:\n  displayName: 行囊\n",
    );
    const units = await pluginLabelUnits(dir);
    await writePluginTranslations(dir, "zh", {
      labels: [
        { unit: units[1]!, text: "保管背包。" },
        { unit: units[2]!, text: "打开背包。" },
        { unit: units[3]!, text: "初始物品" },
      ],
      messages: { Bag: "背包", "Empty.": "空的。" },
    });

    const written = await fs.readFile(
      path.join(dir, "locales/zh.yaml"),
      "utf-8",
    );
    expect(written).toContain("# Checked by a person.");
    expect(written).toContain("displayName: 行囊");
    expect(written).toContain("- name: bag\n        description: 打开背包。");
    // The file the tool wrote is one the loader and the validator accept.
    expect(await validatePluginLabels(dir)).toEqual([]);
    const status = await pluginTranslationStatus(dir, "zh");
    expect(status.labels.missing).toEqual([]);
    expect(status.messages.missing).toEqual([]);
  });

  it("marks a label translation stale when its English text changes", async () => {
    await write(
      "locales/zh.yaml",
      "PLUGIN.md:\n  displayName: 行囊\n  description: 保管背包。\n",
    );
    // Before a lock, nothing says which English text a translation is for.
    expect(
      (await pluginTranslationStatus(dir, "zh")).labels.unlocked,
    ).toHaveLength(2);

    expect(await lockPluginLabels(dir)).toBe(2);
    let status = await pluginTranslationStatus(dir, "zh");
    expect(status.labels.unlocked).toEqual([]);
    expect(status.labels.stale).toEqual([]);

    await write("PLUGIN.md", manifest("Keeps the bag and counts its weight."));
    status = await pluginTranslationStatus(dir, "zh");
    expect(status.labels.stale.map((unit) => unit.pointer)).toEqual([
      "description",
    ]);

    // The lock is not a locale file: the loader and the validator ignore it.
    expect(await validatePluginLabels(dir)).toEqual([]);
  });
});
