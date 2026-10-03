import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadRuntime,
  loadPluginDefinition,
  loadPluginEntryDefinition,
} from "../src/load.js";
import { reconcileLocalizedManifest } from "../src/localized-manifest.js";
import type { PluginDiscoveryResult } from "../src/types.js";

/**
 * The canonical `PLUGIN.md` is English and holds the contract. `PLUGIN.zh.md`
 * is its Chinese variant: a translation, not a second manifest. If it could
 * change contract fields, the same runtime would schedule differently or reach
 * different tools depending on the session language.
 */
describe("localized manifest / canonical manifest consistency", () => {
  let dir: string;

  const CANONICAL = `---
id: demo
kind: plugin
description: English description
provides: [narrative-engine@1]
runtime:
  type: agent
  schedule: {stage: narrative}
  io: {output: {contract: narrative-engine@1}}
  agent: {tools: {builtin: [plugin-data-set]}}
---
English prompt body.
`;
  const CHINESE = `---
id: demo
kind: plugin
description: 中文描述
provides: [narrative-engine@1, image-generation@1]
runtime:
  type: agent
  schedule: {stage: pre-turn}
  io: {output: {contract: narrative-engine@1}}
  agent: {tools: {builtin: [plugin-data-set, emit-event]}}
---
中文提示词。
`;

  function discoveryOf(): PluginDiscoveryResult {
    return {
      id: "demo",
      rootPath: dir,
      pluginMdPaths: [path.join(dir, "PLUGIN.md")],
      isMultiRuntime: false,
    } as PluginDiscoveryResult;
  }

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "covel-locale-"));
    await fs.writeFile(path.join(dir, "PLUGIN.md"), CANONICAL);
    await fs.writeFile(path.join(dir, "PLUGIN.zh.md"), CHINESE);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("selects prose from the captured definition without reopening edited files", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const discovery = discoveryOf();
    const captured = await loadPluginDefinition(discovery);
    await fs.writeFile(
      path.join(dir, "PLUGIN.zh.md"),
      CHINESE.replace("中文提示词。", "新的中文版本。"),
    );
    const oldChinese = await loadRuntime(discovery, "demo", "zh-CN", captured);
    expect(oldChinese.promptTemplate).toContain("中文提示词。");
    expect(oldChinese.manifest.stage).toBe("narrative");
    expect(oldChinese.manifest.tools?.builtin).toEqual(["plugin-data-set"]);
    for (const locale of ["en-US", "ru-RU"]) {
      expect(
        (await loadRuntime(discovery, "demo", locale, captured)).promptTemplate,
      ).toContain("English prompt body.");
    }
    const next = await loadPluginDefinition(discovery);
    expect(
      (await loadRuntime(discovery, "demo", "zh-CN", next)).promptTemplate,
    ).toContain("新的中文版本。");
  });

  it("captures multi-runtime translations without changing the canonical tool contract", async () => {
    await fs.writeFile(
      path.join(dir, "PLUGIN.md"),
      "---\nid: demo\nkind: plugin\ndescription: Demo\n---\n",
    );
    await fs.rm(path.join(dir, "PLUGIN.zh.md"));
    const runtimeDir = path.join(dir, "runtimes", "story");
    await fs.mkdir(runtimeDir, { recursive: true });
    const runtime =
      "---\ntype: agent\nschedule: {stage: narrative}\nagent: {tools: {builtin: [plugin-data-set]}}\n---\nCanonical body.\n";
    await fs.writeFile(path.join(runtimeDir, "RUNTIME.md"), runtime);
    await fs.writeFile(
      path.join(runtimeDir, "RUNTIME.zh.md"),
      runtime.replace("Canonical body.", "中文正文。"),
    );
    const discovery: PluginDiscoveryResult = {
      id: "demo",
      rootPath: dir,
      isMultiRuntime: true,
      pluginMdPaths: [path.join(runtimeDir, "RUNTIME.md")],
    };
    const captured = await loadPluginDefinition(discovery);
    await fs.writeFile(
      path.join(runtimeDir, "RUNTIME.zh.md"),
      runtime.replace("Canonical body.", "磁盘上已修改。"),
    );
    const loaded = await loadRuntime(
      discovery,
      "demo/story",
      "zh-CN",
      captured,
    );
    expect(loaded.promptTemplate).toContain("中文正文。");
    expect(loaded.manifest.tools?.builtin).toEqual(["plugin-data-set"]);
    expect(
      (await loadRuntime(discovery, "demo/story", "en-US", captured))
        .promptTemplate,
    ).toContain("Canonical body.");
  });

  it("takes contract fields from PLUGIN.md and prose from the Chinese variant", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const loaded = await loadRuntime(discoveryOf(), "demo", "zh-CN");

    expect(loaded.manifest.stage).toBe("narrative");
    expect(loaded.manifest.outputContract).toEqual("narrative-engine@1");
    expect(loaded.manifest.tools?.builtin).toEqual(["plugin-data-set"]);
    // Prose and prompt body still come from the translation.
    expect(loaded.manifest.description).toBe("中文描述");
    expect(loaded.promptTemplate).toContain("中文提示词。");
    // The drift is reported rather than swallowed.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("PLUGIN.zh.md"));
  });

  it("reads the canonical English prompt for every non-Chinese locale", async () => {
    for (const locale of ["en-US", "ru-RU", "ja-JP", undefined]) {
      const loaded = await loadRuntime(discoveryOf(), "demo", locale);
      expect(loaded.promptTemplate).toContain("English prompt body.");
      expect(loaded.promptTemplate).not.toContain("中文提示词");
      expect(loaded.manifest.description).toBe("English description");
    }
  });

  it("reads the Chinese variant for Simplified Chinese locales, most specific file first", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const locale of ["zh-CN", "zh", "zh-Hans", "zh-SG"]) {
      const loaded = await loadRuntime(discoveryOf(), "demo", locale);
      expect(loaded.promptTemplate).toContain("中文提示词。");
    }
    // Scripts never substitute for each other: Simplified instructions pull
    // a Traditional Chinese session's output toward Simplified characters.
    for (const locale of ["zh-Hant-TW", "zh-TW", "zh-HK"]) {
      const loaded = await loadRuntime(discoveryOf(), "demo", locale);
      expect(loaded.promptTemplate).toContain("English prompt body.");
    }
    await fs.writeFile(
      path.join(dir, "PLUGIN.zh-CN.md"),
      CHINESE.replace("中文提示词。", "大陆简体版本。"),
    );
    expect(
      (await loadRuntime(discoveryOf(), "demo", "zh-CN")).promptTemplate,
    ).toContain("大陆简体版本。");
  });

  it("falls back to the canonical English prompt when a plugin has no Chinese variant", async () => {
    await fs.rm(path.join(dir, "PLUGIN.zh.md"));
    const loaded = await loadRuntime(discoveryOf(), "demo", "zh-CN");
    expect(loaded.promptTemplate).toContain("English prompt body.");
  });

  it("lets COVEL_INSTRUCTION_LOCALE force one instruction language for all sessions", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("COVEL_INSTRUCTION_LOCALE", "en");
    expect(
      (await loadRuntime(discoveryOf(), "demo", "zh-CN")).promptTemplate,
    ).toContain("English prompt body.");
    vi.stubEnv("COVEL_INSTRUCTION_LOCALE", "zh");
    expect(
      (await loadRuntime(discoveryOf(), "demo", "ru-RU")).promptTemplate,
    ).toContain("中文提示词。");
  });

  it("does not read a variant file in a language that has no instruction set", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await fs.rm(path.join(dir, "PLUGIN.zh.md"));
    await fs.writeFile(
      path.join(dir, "PLUGIN.ru.md"),
      CANONICAL.replace("English prompt body.", "Русский текст."),
    );

    const loaded = await loadRuntime(discoveryOf(), "demo", "ru-RU");

    expect(loaded.promptTemplate).toContain("English prompt body.");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("PLUGIN.ru.md"));
  });

  it("loads a body-only variant with an empty frontmatter block", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await fs.writeFile(
      path.join(dir, "PLUGIN.zh.md"),
      "---\n---\n\n只翻译正文。\n",
    );

    const loaded = await loadRuntime(discoveryOf(), "demo", "zh-CN");

    expect(loaded.manifest.description).toBe("English description");
    expect(loaded.manifest.stage).toBe("narrative");
    expect(loaded.manifest.outputContract).toEqual("narrative-engine@1");
    expect(loaded.manifest.tools?.builtin).toEqual(["plugin-data-set"]);
    expect(loaded.promptTemplate).toContain("只翻译正文。");
    expect(warn).not.toHaveBeenCalled();
  });

  it("captures the Chinese variant of root prompt contributions before execution", async () => {
    await fs.writeFile(
      path.join(dir, "PLUGIN.md"),
      "---\nid: demo\nkind: plugin\ndescription: Demo\ncontributes: {prompt: [{id: guide, content: English, position: pre-history}]}\n---\n",
    );
    await fs.writeFile(
      path.join(dir, "PLUGIN.zh.md"),
      "---\ncontributes: {prompt: [{id: guide, content: 中文, position: pre-history}]}\n---\n",
    );
    const discovery = {
      id: "demo",
      rootPath: dir,
      pluginMdPaths: [],
      isMultiRuntime: false,
    };
    const definition = await loadPluginDefinition(discovery);
    const entry = await loadPluginEntryDefinition(discovery, [
      definition.packageManifest,
    ]);
    expect(entry.staticPromptSegments[0].content).toBe("English");
    expect(entry.staticPromptVariants?.["zh"]?.[0].content).toBe("中文");
    await fs.writeFile(path.join(dir, "PLUGIN.zh.md"), "broken after capture");
    expect(
      Object.values(entry.staticPromptVariants ?? {})
        .flat()
        .map((segment) => segment.content),
    ).toEqual(["中文"]);
  });

  it("validates translated prose after inheriting the canonical contract", async () => {
    await fs.writeFile(
      path.join(dir, "PLUGIN.zh.md"),
      "---\nid: demo\ndescription: 42\n---\n中文提示词。\n",
    );
    await expect(loadRuntime(discoveryOf(), "demo", "zh-CN")).rejects.toThrow(
      "description",
    );
  });
});

describe("reconcileLocalizedManifest omitted fields", () => {
  it("inherits omitted structural fields silently instead of reporting drift", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // A translation that only carries prose is the intended shape: omitting a
    // structural field means "inherit it", not "fork it". Reporting that as
    // drift is what forced every locale file to mirror the whole manifest —
    // and mirrored manifests are exactly what goes stale.
    const canonical = {
      name: "demo",
      stage: "post-turn",
      needs: ["pregame"],
      tools: { builtin: ["plugin-data-set"] },
      description: "中文描述",
    } as unknown as import("@covel/shared").RuntimeManifest;
    const localized = {
      name: "demo",
      description: "English description",
    } as unknown as import("@covel/shared").RuntimeManifest;

    const merged = reconcileLocalizedManifest(
      canonical,
      localized,
      "PLUGIN.en.md",
    ) as unknown as {
      stage: string;
      needs: string[];
      tools: { builtin: string[] };
      description: string;
    };

    expect(merged.stage).toBe("post-turn");
    expect(merged.needs).toEqual(["pregame"]);
    expect(merged.tools.builtin).toEqual(["plugin-data-set"]);
    expect(merged.description).toBe("English description");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("still reports a field the translation declares with a different value", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const canonical = {
      name: "demo",
      stage: "post-turn",
    } as unknown as import("@covel/shared").RuntimeManifest;
    const localized = {
      name: "demo",
      stage: "narrative",
    } as unknown as import("@covel/shared").RuntimeManifest;

    const merged = reconcileLocalizedManifest(
      canonical,
      localized,
      "PLUGIN.en.md",
    ) as unknown as { stage: string };

    expect(merged.stage).toBe("post-turn");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("stage"));
    warn.mockRestore();
  });
});

describe("localized contribution identities", () => {
  it("preserves contribution ids while translating labels and content", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const canonical = {
      contributes: {
        settings: [{ key: "tone", label: "Tone" }],
        prompt: [
          { id: "reminder", content: "Reminder", position: "pre-history" },
        ],
      },
    };
    const localized = {
      contributes: {
        settings: [{ key: "translated-key", label: "语气" }],
        prompt: [{ id: "translated-id", content: "提醒", position: "system" }],
      },
    };
    const merged = reconcileLocalizedManifest(
      canonical,
      localized,
      "PLUGIN.zh.md",
    );
    expect(merged.contributes.settings).toEqual([
      { key: "tone", label: "语气" },
    ]);
    expect(merged.contributes.prompt).toEqual([
      { id: "reminder", content: "提醒", position: "pre-history" },
    ]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
