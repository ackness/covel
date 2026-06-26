import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { getPluginTrustInfo, deriveBuiltinPluginIds } from "../src/trust.js";
import { discoverPluginsMulti } from "../src/discover.js";

/** Repo-root `plugins/` directory (…/packages/plugin-loader/tests → ../../../). */
const PLUGINS_DIR = fileURLToPath(new URL("../../../plugins", import.meta.url));

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

describe("getPluginTrustInfo", () => {
  describe("source-based classification", () => {
    it("classifies a plugin loaded from `plugins/` as builtin (autoLoad, no approval)", () => {
      // The bootstrap layer passes `source: 'builtin'` based on the load
      // path; the trust resolver does not infer trust from the name.
      const info = getPluginTrustInfo("narrator", "builtin");

      expect(info.source).toBe("builtin");
      expect(info.autoLoad).toBe(true);
      expect(info.requiresApproval).toBe(false);
    });

    it("classifies an explicit official plugin as autoLoad with no approval", () => {
      const info = getPluginTrustInfo("some-official-plugin", "official");

      expect(info.source).toBe("official");
      expect(info.autoLoad).toBe(true);
      expect(info.requiresApproval).toBe(false);
    });
  });

  describe("community fallback", () => {
    it("classifies unknown plugins (no source override) as community requiring approval", () => {
      const info = getPluginTrustInfo("my-custom-plugin");

      expect(info.source).toBe("community");
      expect(info.autoLoad).toBe(false);
      expect(info.requiresApproval).toBe(true);
    });

    it("treats a name matching a builtin ID as community when no source is provided", () => {
      // Names alone never grant builtin trust — only the load path does.
      // This guards against a third-party plugin claiming `narrator` and
      // being auto-trusted via name-only inference.
      const info = getPluginTrustInfo("narrator");

      expect(info.source).toBe("community");
      expect(info.autoLoad).toBe(false);
      expect(info.requiresApproval).toBe(true);
    });
  });

  describe("deriveBuiltinPluginIds — reservation list consistency", () => {
    it("filters a discovered set down to exactly the `source: 'builtin'` ids", () => {
      const derived = deriveBuiltinPluginIds([
        { id: "narrator", source: "builtin" },
        { id: "user-mod", source: "community" },
        { id: "blessed", source: "official" },
        { id: "no-source" }, // unclassified → not reserved
      ]);

      expect([...derived].sort()).toEqual(["narrator"]);
    });

    it("equals the actual `plugins/` directory contents (auto-syncs, no hand-maintained list)", async () => {
      // Derivation pipeline: discover the bundled directory (index 0 → 'builtin')
      // then filter via deriveBuiltinPluginIds — exactly what server bootstrap does.
      const discovered = await discoverPluginsMulti([PLUGINS_DIR]);
      const derived = deriveBuiltinPluginIds(discovered);

      // Independent ground truth: read the directory ourselves and keep only the
      // real plugin folders (a dir holding a PLUGIN.md or a runtimes/ subdir).
      // Non-plugin entries such as the `.gitignore` file are dropped by isDirectory().
      const dirents = await fs.readdir(PLUGINS_DIR, { withFileTypes: true });
      const expected = new Set<string>();
      for (const d of dirents) {
        if (!d.isDirectory()) continue;
        const root = path.join(PLUGINS_DIR, d.name);
        const hasManifest = await pathExists(path.join(root, "PLUGIN.md"));
        const hasRuntimes = await isDir(path.join(root, "runtimes"));
        if (hasManifest || hasRuntimes) expected.add(d.name);
      }

      expect([...derived].sort()).toEqual([...expected].sort());
      // Sanity floor: every bundled plugin is reserved (catches an empty derive).
      expect(derived.size).toBeGreaterThanOrEqual(expected.size);
      expect(derived.size).toBeGreaterThan(0);
    });
  });
});
