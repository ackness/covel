import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginDefinition, resolveRuntimePrompt } from "../src/load.js";
import { validatePluginLabels } from "../src/locale-labels.js";
import type { PluginDiscoveryResult } from "../src/types.js";

/**
 * `PLUGIN.md` is written in English. What a player sees in another language
 * comes from `locales/<locale>.yaml`; the loader compiles it into the locale
 * maps the client resolves by UI language.
 */
describe("plugin label translations", () => {
  let dir: string;

  const PLUGIN = `---
id: demo
kind: plugin
displayName: Inventory
description: Keeps the protagonist's bag.
provides: [narrative-engine@1]
contributes:
  commands:
    - name: bag
      description: Open the bag.
      action: open-bag
    - name: drop
      description: Drop an item.
      action: drop-item
  actions: [open-bag, drop-item]
  prompt:
    - id: post-history
      content: Call the tool once.
      position: post-history
      role: system
runtime:
  type: agent
  schedule: {stage: narrative}
  io: {output: {contract: narrative-engine@1}}
  agent: {tools: {builtin: [plugin-data-set]}}
---
English prompt body.
`;
  const CHINESE_LABELS = `
PLUGIN.md:
  displayName: 行囊
  description: 保管主角的背包。
  contributes:
    commands:
      - name: drop
        description: 丢弃一件物品。
`;

  const discovery = (): PluginDiscoveryResult =>
    ({
      id: "demo",
      rootPath: dir,
      pluginMdPaths: [path.join(dir, "PLUGIN.md")],
      isMultiRuntime: false,
    }) as PluginDiscoveryResult;
  const labels = (name: string, text: string) =>
    fs.writeFile(path.join(dir, "locales", name), text);

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "covel-labels-"));
    await fs.mkdir(path.join(dir, "locales"));
    await fs.writeFile(path.join(dir, "PLUGIN.md"), PLUGIN);
    await labels("zh.yaml", CHINESE_LABELS);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("compiles the label file into locale maps on the manifest", async () => {
    const { plugin } = (await loadPluginDefinition(discovery()))
      .packageManifest;
    expect(plugin.displayName).toEqual({ en: "Inventory", zh: "行囊" });
    expect(plugin.description).toEqual({
      en: "Keeps the protagonist's bag.",
      zh: "保管主角的背包。",
    });
    // Commands are matched by name; an untranslated one keeps its English.
    expect(plugin.contributes?.commands).toMatchObject([
      { name: "bag", description: "Open the bag." },
      {
        name: "drop",
        description: { en: "Drop an item.", zh: "丢弃一件物品。" },
      },
    ]);
    expect(await validatePluginLabels(dir)).toEqual([]);
  });

  it("gives the same labels to every session language and keeps prompts apart", async () => {
    await fs.writeFile(
      path.join(dir, "PLUGIN.zh.md"),
      "---\n---\n中文提示词。\n",
    );
    for (const locale of ["zh-CN", "en-US", "ru-RU"]) {
      const definition = await loadPluginDefinition(discovery(), locale);
      // Labels follow the viewer's UI language, so all of them are loaded.
      expect(definition.packageManifest.plugin.displayName).toEqual({
        en: "Inventory",
        zh: "行囊",
      });
      // The prompt follows the session's instruction language.
      expect(resolveRuntimePrompt(definition.manifests[0]!, locale)).toContain(
        locale === "zh-CN" ? "中文提示词。" : "English prompt body.",
      );
    }
  });

  it("adds a language with one more file", async () => {
    await labels("ru.yaml", "PLUGIN.md:\n  displayName: Инвентарь\n");
    const { plugin } = (await loadPluginDefinition(discovery()))
      .packageManifest;
    expect(plugin.displayName).toEqual({
      en: "Inventory",
      ru: "Инвентарь",
      zh: "行囊",
    });
  });

  it("ignores an entry it cannot place and reports it in validation", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await labels(
      "zh.yaml",
      `
PLUGIN.md:
  displayName: 行囊
  subtitle: 副标题
  runtime:
    type: 代理
  contributes:
    commands:
      - name: sell
        description: 出售。
    prompt:
      - id: post-history
        content: 只调用一次工具。
runtimes/gone/RUNTIME.md:
  description: 不存在
`,
    );
    await labels("notes.yaml", "PLUGIN.md:\n  displayName: X\n");

    const { plugin } = (await loadPluginDefinition(discovery()))
      .packageManifest;
    // The manifest stays valid: the contract and the prompt are untouched.
    expect(plugin.runtime?.type).toBe("agent");
    expect(plugin.contributes?.prompt?.[0]?.content).toBe(
      "Call the tool once.",
    );
    expect(warn).toHaveBeenCalled();

    const problems = (await validatePluginLabels(dir)).join("\n");
    expect(problems).toContain("subtitle is not a label");
    expect(problems).toContain("runtime.type is not a label");
    expect(problems).toContain("[name=sell] has no entry with this id");
    expect(problems).toContain(
      "contributes.prompt is prompt text, not a label",
    );
    expect(problems).toContain(
      'section "runtimes/gone/RUNTIME.md" is not "messages" or a manifest file',
    );
    expect(problems).toContain('"notes" is not a language tag');
  });

  it("loads the plugin when a label file does not parse", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await labels(
      "zh.yaml",
      "PLUGIN.md:\n  displayName: 行囊\n  displayName: 背包\n",
    );
    const { plugin } = (await loadPluginDefinition(discovery()))
      .packageManifest;
    expect(plugin.displayName).toBe("Inventory");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("cannot be parsed, its labels are ignored"),
    );
    expect((await validatePluginLabels(dir)).join("\n")).toContain(
      "locales/zh.yaml: cannot be parsed",
    );
  });

  it("rejects a label written as a locale map in the main file", async () => {
    await fs.writeFile(
      path.join(dir, "PLUGIN.md"),
      PLUGIN.replace(
        "displayName: Inventory",
        "displayName: { zh: 行囊, en: Inventory }",
      ),
    );
    await labels("zh.yaml", "PLUGIN.md:\n  description: 保管主角的背包。\n");
    expect((await validatePluginLabels(dir)).join("\n")).toContain(
      "PLUGIN.md: 1 label(s) written as a locale map (displayName)",
    );
  });
});
