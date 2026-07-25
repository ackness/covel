import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadRuntime } from "../src/load.js";
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
name: demo
description: 中文描述
stage: narrative
capabilities:
  - narrative
tools:
  builtin:
    - plugin-data-set
---

中文提示词。
`;

  const LOCALIZED = `---
name: demo
description: English description
stage: pre-turn
capabilities:
  - narrative
  - image-generation
tools:
  builtin:
    - plugin-data-set
    - emit-event
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
    expect(loaded.manifest.capabilities).toEqual(["narrative"]);
    expect(loaded.manifest.tools?.builtin).toEqual(["plugin-data-set"]);
    // Prose and prompt body still come from the translation.
    expect(loaded.manifest.description).toBe("English description");
    expect(loaded.promptTemplate).toContain("English prompt body.");
    // The drift is reported rather than swallowed.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("PLUGIN.en.md"));
    warn.mockRestore();
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

describe("reconcileLocalizedManifest machine-field paths", () => {
  it("keeps memoryBlocks[*].label from canonical while translating real prose", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // `label` is display prose in most places (userSettings here) but a stable
    // machine key inside memoryBlocks — translating it would split the block's
    // working_memory key per UI language.
    const canonical = {
      name: "demo",
      memoryBlocks: [{ label: "core", displayName: "Core", content: "seed" }],
      userSettings: [{ key: "tone", label: "Tone" }],
    } as unknown as import("@covel/shared").RuntimeManifest;
    const localized = {
      name: "demo",
      memoryBlocks: [
        { label: "核心", displayName: "核心记忆", content: "种子" },
      ],
      userSettings: [{ key: "tone", label: "语气" }],
    } as unknown as import("@covel/shared").RuntimeManifest;

    const merged = reconcileLocalizedManifest(
      canonical,
      localized,
      "PLUGIN.zh.md",
    ) as unknown as {
      memoryBlocks: { label: string; displayName: string }[];
      userSettings: { label: string }[];
    };

    expect(merged.memoryBlocks[0].label).toBe("core"); // machine key: canonical
    expect(merged.memoryBlocks[0].displayName).toBe("核心记忆"); // prose: translated
    expect(merged.userSettings[0].label).toBe("语气"); // genuine I18nText: translated
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("memoryBlocks[0].label"),
    );
    warn.mockRestore();
  });
});
