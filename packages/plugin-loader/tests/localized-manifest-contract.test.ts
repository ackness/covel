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
 * A `PLUGIN.<locale>.md` is a translation, not a second manifest. If it can
 * change contract fields, the same runtime schedules at a different priority
 * or reaches different tools depending on the player's UI language.
 */
describe("localized manifest / canonical manifest consistency", () => {
  let dir: string;

  const CANONICAL = `---
id: demo
kind: plugin
description: 中文描述
provides: [narrative-engine@1]
runtime:
  type: agent
  schedule: {stage: narrative}
  io: {output: {contract: narrative-engine@1}}
  agent: {tools: {builtin: [plugin-data-set]}}
---
中文提示词。
`;
  const LOCALIZED = `---
id: demo
kind: plugin
description: English description
provides: [narrative-engine@1, image-generation@1]
runtime:
  type: agent
  schedule: {stage: pre-turn}
  io: {output: {contract: narrative-engine@1}}
  agent: {tools: {builtin: [plugin-data-set, emit-event]}}
---
English prompt body.
`;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "covel-locale-"));
    await fs.writeFile(path.join(dir, "PLUGIN.md"), CANONICAL);
    await fs.writeFile(path.join(dir, "PLUGIN.en.md"), LOCALIZED);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("selects localized prose from the captured definition without reopening edited files", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const discovery: PluginDiscoveryResult = {
      id: "demo",
      rootPath: dir,
      pluginMdPaths: [path.join(dir, "PLUGIN.md")],
      isMultiRuntime: false,
    };
    const captured = await loadPluginDefinition(discovery);
    await fs.writeFile(
      path.join(dir, "PLUGIN.en.md"),
      LOCALIZED.replace("English prompt body.", "New English generation."),
    );
    const oldEnglish = await loadRuntime(discovery, "demo", "en-US", captured);
    expect(oldEnglish.promptTemplate).toContain("English prompt body.");
    expect(oldEnglish.manifest.stage).toBe("narrative");
    expect(oldEnglish.manifest.tools?.builtin).toEqual(["plugin-data-set"]);
    expect(
      (await loadRuntime(discovery, "demo", "ru-RU", captured)).promptTemplate,
    ).toBe(oldEnglish.promptTemplate);
    expect(
      (await loadRuntime(discovery, "demo", "zh-CN", captured)).promptTemplate,
    ).toContain("中文提示词");
    const next = await loadPluginDefinition(discovery);
    expect(
      (await loadRuntime(discovery, "demo", "en-US", next)).promptTemplate,
    ).toContain("New English generation.");
    vi.restoreAllMocks();
  });

  it("captures multi-runtime translations without changing the canonical tool contract", async () => {
    await fs.writeFile(
      path.join(dir, "PLUGIN.md"),
      "---\nid: demo\nkind: plugin\ndescription: Demo\n---\n",
    );
    await fs.rm(path.join(dir, "PLUGIN.en.md"));
    const runtimeDir = path.join(dir, "runtimes", "story");
    await fs.mkdir(runtimeDir, { recursive: true });
    const runtime =
      "---\ntype: agent\nschedule: {stage: narrative}\nagent: {tools: {builtin: [plugin-data-set]}}\n---\nCanonical body.\n";
    await fs.writeFile(path.join(runtimeDir, "RUNTIME.md"), runtime);
    await fs.writeFile(
      path.join(runtimeDir, "RUNTIME.en.md"),
      runtime.replace("Canonical body.", "English runtime body."),
    );
    const discovery: PluginDiscoveryResult = {
      id: "demo",
      rootPath: dir,
      isMultiRuntime: true,
      pluginMdPaths: [path.join(runtimeDir, "RUNTIME.md")],
    };
    const captured = await loadPluginDefinition(discovery);
    await fs.writeFile(
      path.join(runtimeDir, "RUNTIME.en.md"),
      runtime.replace("Canonical body.", "Changed on disk."),
    );
    const loaded = await loadRuntime(
      discovery,
      "demo/story",
      "en-US",
      captured,
    );
    expect(loaded.promptTemplate).toContain("English runtime body.");
    expect(loaded.manifest.tools?.builtin).toEqual(["plugin-data-set"]);
  });

  it("takes contract fields from PLUGIN.md and prose from the locale variant", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const discovery: PluginDiscoveryResult = {
      id: "demo",
      rootPath: dir,
      pluginMdPaths: [path.join(dir, "PLUGIN.md")],
      isMultiRuntime: false,
    } as PluginDiscoveryResult;

    const loaded = await loadRuntime(discovery, "demo", "en-US");

    expect(loaded.manifest.stage).toBe("narrative");
    expect(loaded.manifest.outputContract).toEqual("narrative-engine@1");
    expect(loaded.manifest.tools?.builtin).toEqual(["plugin-data-set"]);
    // Prose and prompt body still come from the translation.
    expect(loaded.manifest.description).toBe("English description");
    expect(loaded.promptTemplate).toContain("English prompt body.");
    // The drift is reported rather than swallowed.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("PLUGIN.en.md"));
    warn.mockRestore();
  });

  it("uses the English prompt fallback when the requested locale is missing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const discovery: PluginDiscoveryResult = {
      id: "demo",
      rootPath: dir,
      pluginMdPaths: [path.join(dir, "PLUGIN.md")],
      isMultiRuntime: false,
    } as PluginDiscoveryResult;

    const loaded = await loadRuntime(discovery, "demo", "ru-RU");

    expect(loaded.promptTemplate).toContain("English prompt body.");
    expect(loaded.promptTemplate).not.toContain("中文提示词");
    warn.mockRestore();
  });

  it("does not cross from Traditional Chinese to a Simplified short-key prompt", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await fs.writeFile(
      path.join(dir, "PLUGIN.zh.md"),
      CANONICAL.replace("中文提示词。", "简体短键提示词。"),
    );
    const discovery: PluginDiscoveryResult = {
      id: "demo",
      rootPath: dir,
      pluginMdPaths: [path.join(dir, "PLUGIN.md")],
      isMultiRuntime: false,
    } as PluginDiscoveryResult;

    const loaded = await loadRuntime(discovery, "demo", "zh-Hant-TW");

    expect(loaded.promptTemplate).toContain("English prompt body.");
    expect(loaded.promptTemplate).not.toContain("简体短键提示词。");
    warn.mockRestore();
  });

  it("keeps the canonical prompt for the default locale and its aliases", async () => {
    const discovery: PluginDiscoveryResult = {
      id: "demo",
      rootPath: dir,
      pluginMdPaths: [path.join(dir, "PLUGIN.md")],
      isMultiRuntime: false,
    } as PluginDiscoveryResult;

    for (const locale of ["zh-CN", "zh", "zh-Hans"]) {
      const loaded = await loadRuntime(discovery, "demo", locale);
      expect(loaded.promptTemplate).toContain("中文提示词。");
    }
  });

  it.each(["en-US", "ru-RU"])(
    "loads a minimal translation with canonical required fields and defaults (%s)",
    async (locale) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await fs.writeFile(
        path.join(dir, "PLUGIN.en.md"),
        "---\nid: demo\n---\n\nEnglish prompt body.\n",
      );
      const loaded = await loadRuntime(
        {
          id: "demo",
          rootPath: dir,
          pluginMdPaths: [path.join(dir, "PLUGIN.md")],
          isMultiRuntime: false,
        } as PluginDiscoveryResult,
        "demo",
        locale,
      );

      expect(loaded.manifest.description).toBe("中文描述");
      expect(loaded.manifest.stage).toBe("narrative");
      expect(loaded.manifest.outputContract).toEqual("narrative-engine@1");
      expect(loaded.manifest.tools?.builtin).toEqual(["plugin-data-set"]);
      expect(loaded.promptTemplate).toContain("English prompt body.");
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    },
  );

  it("captures localized root prompt contributions before execution", async () => {
    await fs.writeFile(
      path.join(dir, "PLUGIN.md"),
      "---\nid: demo\nkind: plugin\ndescription: Demo\ncontributes: {prompt: [{id: guide, content: 中文, position: pre-history}]}\n---\n",
    );
    await fs.writeFile(
      path.join(dir, "PLUGIN.en.md"),
      "---\ncontributes: {prompt: [{id: guide, content: English, position: pre-history}]}\n---\n",
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
    expect(entry.staticPromptSegments[0].content).toBe("中文");
    expect(
      entry.staticPromptVariants?.["en"]?.[0].content ??
        entry.staticPromptVariants?.["en-US"]?.[0].content,
    ).toBe("English");
    await fs.writeFile(path.join(dir, "PLUGIN.en.md"), "broken after capture");
    expect(
      Object.values(entry.staticPromptVariants ?? {})
        .flat()
        .map((segment) => segment.content),
    ).toEqual(["English"]);
  });

  it("validates translated prose after inheriting the canonical contract", async () => {
    await fs.writeFile(
      path.join(dir, "PLUGIN.en.md"),
      "---\nid: demo\ndescription: 42\n---\nEnglish prompt.\n",
    );
    await expect(
      loadRuntime(
        {
          id: "demo",
          rootPath: dir,
          pluginMdPaths: [path.join(dir, "PLUGIN.md")],
          isMultiRuntime: false,
        } as PluginDiscoveryResult,
        "demo",
        "en-US",
      ),
    ).rejects.toThrow("description");
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
