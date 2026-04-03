/**
 * Integration test: verify that the actual worlds/ directory loads correctly.
 */
import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { loadWorldPackages } from "../src/store/world-package-loader.js";

const WORLDS_DIR = resolve(import.meta.dirname, "../../../worlds");

describe("Real world packages — integration", () => {
  it("should load 3 world packages from worlds/ directory", async () => {
    const worlds = await loadWorldPackages(WORLDS_DIR);
    expect(worlds).toHaveLength(3);
  });

  it("should load mistport with i18n name and bilingual lore", async () => {
    const worlds = await loadWorldPackages(WORLDS_DIR);
    const mistport = worlds.find((w) => w.packageId === "mistport");
    expect(mistport).toBeDefined();
    expect(mistport!.name).toEqual({
      "zh-CN": "雾港・裂潮纪",
      "en-US": "Mistport Chronicles",
    });
    expect(mistport!.lore).toBeDefined();
    expect(typeof mistport!.lore).toBe("object");
    const lore = mistport!.lore as Record<string, string>;
    expect(lore["zh-CN"]).toContain("雾港");
    expect(lore["en-US"]).toContain("Mistport");
  });

  it("should load neonridge with zh-CN lore", async () => {
    const worlds = await loadWorldPackages(WORLDS_DIR);
    const neonridge = worlds.find((w) => w.packageId === "neonridge");
    expect(neonridge).toBeDefined();
    expect(neonridge!.name).toBe("霓虹脊・2087");
    expect(neonridge!.locale).toBe("zh-CN");
    expect(neonridge!.dimensions).toBeDefined();
  });

  it("should load cloudmere with dimensions", async () => {
    const worlds = await loadWorldPackages(WORLDS_DIR);
    const cloudmere = worlds.find((w) => w.packageId === "cloudmere");
    expect(cloudmere).toBeDefined();
    expect(cloudmere!.dimensions).toBeDefined();
    expect(cloudmere!.dimensions?.factions).toBeDefined();
    expect(cloudmere!.dimensions!.factions!.length).toBeGreaterThan(0);
  });

  it("all worlds should have valid dimensions or no dimensions", async () => {
    const worlds = await loadWorldPackages(WORLDS_DIR);
    for (const w of worlds) {
      if (w.dimensions) {
        // At least tone should exist in all seed worlds
        expect(w.dimensions.tone).toBeDefined();
      }
    }
  });
});
