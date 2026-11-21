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
import { parsePluginMd } from "../src/parse-plugin-md.js";
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
provides: [demo-output@1]
runtime:
  schedule: {stage: narrative}
  io: {output: {contract: demo-output@1}}
  agent: {tools: {builtin: [sync-characters]}}
---
English prompt body.
`;
  const CHINESE = `---
id: demo
kind: plugin
description: 中文描述
provides: [demo-output@1, image-generation@1]
runtime:
  schedule: {stage: pre-turn}
  io: {output: {contract: demo-output@1}}
  agent: {tools: {builtin: [sync-characters, emit-event]}}
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
    expect(oldChinese.manifest.tools?.builtin).toEqual(["sync-characters"]);
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
      "---\nschedule: {stage: narrative}\nagent: {tools: {builtin: [sync-characters]}}\n---\nCanonical body.\n";
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
    expect(loaded.manifest.tools?.builtin).toEqual(["sync-characters"]);
    expect(
      (await loadRuntime(discovery, "demo/story", "en-US", captured))
        .promptTemplate,
    ).toContain("Canonical body.");
  });

  describe("contributes.datasets is structural data", () => {
    const datasetsOf = (lines: string[]) =>
      `---\nid: demo\nkind: plugin\ndescription: Demo\ncontributes:\n  datasets:\n${lines.map((l) => `    ${l}`).join("\n")}\n---\n`;

    it("keeps declarations named like prose fields when a variant retranslates them", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const schemaDir = path.join(dir, "schemas");
      await fs.mkdir(schemaDir, { recursive: true });
      for (const file of ["a", "b", "c"])
        await fs.writeFile(
          path.join(schemaDir, `${file}.json`),
          JSON.stringify({ type: "object" }),
        );
      await fs.writeFile(
        path.join(dir, "PLUGIN.md"),
        datasetsOf([
          "description: {schema: ./schemas/a.json, key: id, ops: [set]}",
          "title: {schema: ./schemas/b.json}",
          "content: {schema: ./schemas/c.json}",
        ]),
      );
      await fs.writeFile(
        path.join(dir, "PLUGIN.zh.md"),
        datasetsOf([
          "description: {schema: ./schemas/zh-missing.json, ops: [delete]}",
          "title: {schema: ./schemas/b.json, key: name}",
          "content: {schema: ./schemas/c.json}",
        ]),
      );
      const discovery = discoveryOf();
      const definition = await loadPluginDefinition(discovery);
      const canonical = definition.packageManifest.manifest.datasets;
      expect(canonical).toEqual({
        description: expect.objectContaining({
          schema: "./schemas/a.json",
          key: "id",
          ops: ["set"],
        }),
        title: expect.objectContaining({ schema: "./schemas/b.json" }),
        content: expect.objectContaining({ schema: "./schemas/c.json" }),
      });
      const zh = parsePluginMd(
        await fs.readFile(path.join(dir, "PLUGIN.zh.md"), "utf-8"),
        path.join(dir, "PLUGIN.zh.md"),
        parsePluginMd(
          await fs.readFile(path.join(dir, "PLUGIN.md"), "utf-8"),
          path.join(dir, "PLUGIN.md"),
        ).rawFrontmatter,
      );
      expect(zh.manifest.datasets).toEqual(canonical);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("contributes.datasets"),
      );
    });
  });

  it("takes contract fields from PLUGIN.md and prose from the Chinese variant", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const loaded = await loadRuntime(discoveryOf(), "demo", "zh-CN");

    expect(loaded.manifest.stage).toBe("narrative");
    expect(loaded.manifest.outputContract).toEqual("demo-output@1");
    expect(loaded.manifest.tools?.builtin).toEqual(["sync-characters"]);
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
    expect(loaded.manifest.outputContract).toEqual("demo-output@1");
    expect(loaded.manifest.tools?.builtin).toEqual(["sync-characters"]);
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
    const entry = await loadPluginEntryDefinition(
      discovery,
      definition.packageManifest,
      definition.manifests,
    );
    expect(entry.staticPromptSegments[0]!.content).toBe("English");
    expect(entry.staticPromptVariants?.["zh"]?.[0]!.content).toBe("中文");
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
      tools: { builtin: ["sync-characters"] },
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
    expect(merged.tools.builtin).toEqual(["sync-characters"]);
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

describe("author-chosen map keys named like natural-language fields", () => {
  const PROSE_LIKE_KEYS = [
    "content",
    "title",
    "description",
    "label",
    "hint",
    "placeholder",
    "displayName",
    "i18n",
  ] as const;

  it("prevents contributes.data namespaces named like prose fields from overwriting structure while preserving nested prose translation", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const canonical = {
      id: "demo",
      kind: "plugin",
      description: "Demo",
      contributes: {
        data: {
          content: {
            schema: "./schemas/content.json",
            version: 1,
            accepts: ["content@1"],
            description: "Story content records",
            authoring: {
              title: "Story Content",
              hint: "Keep it brief",
              source: {
                path: "data/content.yaml",
                visibility: "hidden",
              },
            },
          },
          // String-only namespace objects (no version/accepts) must not be
          // mistaken for locale maps even under keys like `title` or `i18n`.
          title: { schema: "./schemas/title.json" },
          i18n: { schema: "./schemas/i18n.json" },
        },
      },
    };
    const localized = {
      contributes: {
        data: {
          content: {
            schema: "./schemas/evil.json",
            version: 99,
            accepts: ["hijacked@1"],
            description: "故事内容记录",
            authoring: {
              title: "故事内容",
              hint: "保持简短",
              source: {
                path: "data/evil.yaml",
                visibility: "public",
              },
            },
          },
          title: { schema: "./schemas/evil-title.json" },
          i18n: { schema: "./schemas/evil-i18n.json" },
          // Attempting to inject new namespaces named like prose keys.
          label: { schema: "./schemas/injected.json" },
          description: "not-a-namespace",
        },
      },
    };

    const merged = reconcileLocalizedManifest(
      canonical,
      localized,
      "PLUGIN.zh.md",
    );

    expect(merged.contributes.data).toEqual({
      content: {
        schema: "./schemas/content.json",
        version: 1,
        accepts: ["content@1"],
        description: "故事内容记录",
        authoring: {
          title: "故事内容",
          hint: "保持简短",
          source: {
            path: "data/content.yaml",
            visibility: "hidden",
          },
        },
      },
      title: { schema: "./schemas/title.json" },
      i18n: { schema: "./schemas/i18n.json" },
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("contributes.data.content.schema"),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("contributes.data.title.schema"),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("contributes.data.i18n.schema"),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("contributes.data.label"),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("contributes.data.description"),
    );
    warn.mockRestore();
  });

  it("prevents contributes.worldProjections and nested outputs named like prose fields from being overwritten", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const canonical = {
      id: "demo",
      kind: "plugin",
      description: "Demo",
      contributes: {
        worldProjections: {
          content: {
            from: "world.content@1",
            handler: "./projections/content.js",
            outputs: {
              title: { namespace: "content", key: "id" },
            },
          },
          description: {
            from: "world.desc@1",
            handler: "./projections/desc.js",
            outputs: {
              i18n: { namespace: "desc", key: "slug" },
            },
          },
        },
      },
    };
    const localized = {
      contributes: {
        worldProjections: {
          content: {
            from: "evil@1",
            handler: "./evil.js",
            outputs: {
              title: { namespace: "pwned", key: "other" },
            },
          },
          description: {
            from: "evil@2",
            handler: "./evil2.js",
            outputs: {
              i18n: { namespace: "pwned2", key: "other" },
            },
          },
          label: {
            from: "injected@1",
            handler: "./injected.js",
            outputs: {
              main: { namespace: "injected", key: "id" },
            },
          },
        },
      },
    };

    const merged = reconcileLocalizedManifest(
      canonical,
      localized,
      "PLUGIN.zh.md",
    );

    expect(merged.contributes.worldProjections).toEqual(
      canonical.contributes.worldProjections,
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("contributes.worldProjections"),
    );
    warn.mockRestore();
  });

  it("prevents io.inputs and runtime.io.inputs bindings named like prose fields from being overwritten", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const canonicalInputs = Object.fromEntries(
      PROSE_LIKE_KEYS.map((key) => [
        key,
        { from: { contract: `safe.${key}@1` }, required: true },
      ]),
    );
    const localizedInputs = Object.fromEntries(
      PROSE_LIKE_KEYS.map((key) => [
        key,
        { from: { contract: `evil.${key}@1` }, required: false },
      ]),
    );

    // RUNTIME.md layout (`io.inputs`)
    const runtimeCanonical = {
      description: "Worker",
      schedule: { stage: "post-turn" },
      io: { inputs: canonicalInputs },
    };
    const runtimeLocalized = {
      description: "工作器",
      io: { inputs: localizedInputs },
    };
    const mergedRuntime = reconcileLocalizedManifest(
      runtimeCanonical,
      runtimeLocalized,
      "RUNTIME.zh.md",
    );
    expect(mergedRuntime.description).toBe("工作器");
    expect(mergedRuntime.io.inputs).toEqual(canonicalInputs);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("io.inputs"));

    warn.mockClear();

    // Inline PLUGIN.md layout (`runtime.io.inputs`)
    const pluginCanonical = {
      id: "demo",
      kind: "plugin",
      description: "Demo",
      runtime: {
        schedule: { stage: "post-turn" },
        io: { inputs: canonicalInputs },
      },
    };
    const pluginLocalized = {
      description: "演示",
      runtime: {
        io: { inputs: localizedInputs },
      },
    };
    const mergedPlugin = reconcileLocalizedManifest(
      pluginCanonical,
      pluginLocalized,
      "PLUGIN.zh.md",
    );
    expect(mergedPlugin.description).toBe("演示");
    expect(mergedPlugin.runtime.io.inputs).toEqual(canonicalInputs);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("runtime.io.inputs"),
    );
    warn.mockRestore();
  });

  it("prevents contracts and settings default objects from being overwritten by prose-named keys", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const canonical = {
      id: "demo",
      kind: "plugin",
      description: "Demo",
      contracts: {
        "notes@1": { schema: "./schemas/notes.json" },
      },
      contributes: {
        settings: [
          {
            key: "preset",
            type: "text",
            label: "Preset",
            default: { title: "canonical-title", content: "canonical-body" },
          },
        ],
      },
    };
    const localized = {
      contracts: {
        "notes@1": { schema: "./schemas/evil.json" },
        description: { schema: "./schemas/injected.json" },
      },
      contributes: {
        settings: [
          {
            key: "preset",
            label: "预设",
            default: { title: "evil-title", content: "evil-body" },
          },
        ],
      },
    };

    const merged = reconcileLocalizedManifest(
      canonical,
      localized,
      "PLUGIN.zh.md",
    );

    expect(merged.contracts).toEqual(canonical.contracts);
    expect(merged.contributes.settings).toEqual([
      {
        key: "preset",
        type: "text",
        label: "预设",
        default: { title: "canonical-title", content: "canonical-body" },
      },
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("contracts"));
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("contributes.settings[0].default"),
    );
    warn.mockRestore();
  });

  it.each(PROSE_LIKE_KEYS)(
    "never overwrites a non-prose structural object (including string-only) under key %s even in an uncatalogued container",
    (key) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const canonical = {
        futureMap: {
          [key]: { schema: "./safe.json", visibility: "hidden", version: 1 },
        },
        stringOnlyMap: {
          [key]: { handler: "./safe.js" },
        },
      };
      const localized = {
        futureMap: {
          [key]: { schema: "./evil.json", visibility: "public", version: 2 },
        },
        stringOnlyMap: {
          [key]: { handler: "./evil.js" },
        },
      };

      const merged = reconcileLocalizedManifest(
        canonical,
        localized,
        "PLUGIN.zh.md",
      );

      expect(merged.futureMap[key]).toEqual(canonical.futureMap[key]);
      expect(merged.stringOnlyMap[key]).toEqual(canonical.stringOnlyMap[key]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(`futureMap.${key}.schema`),
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(`stringOnlyMap.${key}.handler`),
      );
      warn.mockRestore();
    },
  );

  it("still translates prose fields whose canonical values are locale maps (including i18n)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const canonical = {
      id: "demo",
      displayName: { en: "Inventory", zh: "行囊" },
      description: { en: "Keeps items.", zh: "保管物品。" },
      i18n: { en: "Hello", zh: "你好" },
    };
    const localized = {
      displayName: "背包",
      description: { en: "Keeps items.", zh: "管理道具。" },
      i18n: { en: "Hello", zh: "您好" },
    };

    const merged = reconcileLocalizedManifest(
      canonical,
      localized,
      "PLUGIN.zh.md",
    );

    expect(merged.displayName).toBe("背包");
    expect(merged.description).toEqual({
      en: "Keeps items.",
      zh: "管理道具。",
    });
    expect(merged.i18n).toEqual({ en: "Hello", zh: "您好" });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("enforces structural protection end-to-end through parsePluginMd on PLUGIN.zh.md", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const canonicalMd = [
      "---",
      "id: demo",
      "kind: plugin",
      "description: English",
      "contributes:",
      "  data:",
      "    content:",
      "      schema: ./schemas/content.json",
      "      version: 1",
      "      description: English data",
      "  worldProjections:",
      "    title:",
      "      from: world.title@1",
      "      handler: ./projections/title.js",
      "      outputs:",
      "        content:",
      "          namespace: content",
      "          key: id",
      "runtime:",
      "  schedule: { stage: post-turn }",
      "  io:",
      "    inputs:",
      "      content:",
      "        from: { contract: safe@1 }",
      "        required: true",
      "---",
      "English body.",
    ].join("\n");
    const zhMd = [
      "---",
      "description: 中文",
      "contributes:",
      "  data:",
      "    content:",
      "      schema: ./schemas/evil.json",
      "      version: 2",
      "      description: 中文数据",
      "  worldProjections:",
      "    title:",
      "      from: evil@1",
      "      handler: ./evil.js",
      "      outputs:",
      "        content:",
      "          namespace: evil",
      "          key: bad",
      "runtime:",
      "  io:",
      "    inputs:",
      "      content:",
      "        from: { contract: evil@1 }",
      "        required: false",
      "---",
      "中文正文。",
    ].join("\n");

    const canonical = parsePluginMd(canonicalMd, "demo/PLUGIN.md");
    const localized = parsePluginMd(
      zhMd,
      "demo/PLUGIN.zh.md",
      canonical.rawFrontmatter,
    );

    expect(localized.plugin.description).toBe("中文");
    expect(localized.plugin.contributes?.data?.content).toEqual({
      schema: "./schemas/content.json",
      version: 1,
      description: "中文数据",
    });
    expect(localized.plugin.contributes?.worldProjections).toEqual(
      canonical.plugin.contributes?.worldProjections,
    );
    expect(localized.plugin.runtime?.io?.inputs).toEqual(
      canonical.plugin.runtime?.io?.inputs,
    );
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
