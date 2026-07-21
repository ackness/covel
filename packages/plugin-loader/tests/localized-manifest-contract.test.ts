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
priority: 500
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
priority: 100
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

    expect(loaded.manifest.priority).toBe(500);
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
