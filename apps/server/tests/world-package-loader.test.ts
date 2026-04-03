/**
 * TDD RED: Tests for the World Package Loader.
 *
 * Uses temporary directories with fixture world packages
 * to test loading world.yaml + WORLD.*.md files.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadWorldPackages } from "../src/store/world-package-loader.js";

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "covel-world-test-"));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

/** Helper: create a world package directory with files. */
async function createWorldFixture(
  name: string,
  files: Record<string, string>,
): Promise<string> {
  const dir = join(testDir, name);
  await mkdir(dir, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(dir, path);
    await mkdir(join(fullPath, ".."), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
  }
  return dir;
}

const MINIMAL_YAML = `
schemaVersion: "1.0"
id: test-world
name: Test World
version: "0.1.0"
summary: A test world for unit testing.
defaultLocale: zh-CN
supportedLocales: [zh-CN]
`;

const I18N_YAML = `
schemaVersion: "1.0"
id: i18n-world
name:
  zh-CN: 测试世界
  en-US: Test World
version: "0.1.0"
summary:
  zh-CN: 一个测试世界
  en-US: A test world
defaultLocale: zh-CN
supportedLocales: [zh-CN, en-US]
tags: [test, fantasy]
`;

// ─── Basic loading ──────────────────────────────────────────────────────────

describe("loadWorldPackages — basic", () => {
  it("should load a minimal world package with world.yaml only", async () => {
    await createWorldFixture("test-world", {
      "world.yaml": MINIMAL_YAML,
    });

    const worlds = await loadWorldPackages(testDir);
    expect(worlds).toHaveLength(1);
    expect(worlds[0].packageId).toBe("test-world");
    expect(worlds[0].name).toBe("Test World");
    expect(worlds[0].description).toBe("A test world for unit testing.");
  });

  it("should return empty array for empty directory", async () => {
    const worlds = await loadWorldPackages(testDir);
    expect(worlds).toEqual([]);
  });

  it("should return empty array for non-existent directory", async () => {
    const worlds = await loadWorldPackages(join(testDir, "nonexistent"));
    expect(worlds).toEqual([]);
  });

  it("should skip directories without world.yaml", async () => {
    await createWorldFixture("no-manifest", {
      "README.md": "# Not a world package",
    });

    const worlds = await loadWorldPackages(testDir);
    expect(worlds).toEqual([]);
  });

  it("should skip world.yaml that fails validation", async () => {
    await createWorldFixture("invalid", {
      "world.yaml": `id: bad\nname: Test\n`,
    });

    const worlds = await loadWorldPackages(testDir);
    expect(worlds).toEqual([]);
  });

  it("should load multiple world packages", async () => {
    await createWorldFixture("world-a", {
      "world.yaml": MINIMAL_YAML.replace("test-world", "world-a"),
    });
    await createWorldFixture("world-b", {
      "world.yaml": MINIMAL_YAML.replace("test-world", "world-b"),
    });

    const worlds = await loadWorldPackages(testDir);
    expect(worlds).toHaveLength(2);
    const ids = worlds.map((w) => w.packageId).sort();
    expect(ids).toEqual(["world-a", "world-b"]);
  });
});

// ─── Lore file loading ──────────────────────────────────────────────────────

describe("loadWorldPackages — lore files", () => {
  it("should load WORLD.md as default locale lore", async () => {
    await createWorldFixture("with-lore", {
      "world.yaml": MINIMAL_YAML,
      "WORLD.md": "# 测试世界\n\n这是世界观。",
    });

    const worlds = await loadWorldPackages(testDir);
    expect(worlds).toHaveLength(1);
    // WORLD.md maps to defaultLocale (zh-CN)
    expect(worlds[0].lore).toEqual({ "zh-CN": "# 测试世界\n\n这是世界观。" });
  });

  it("should load locale-specific WORLD.zh.md and WORLD.en.md", async () => {
    await createWorldFixture("i18n-lore", {
      "world.yaml": I18N_YAML,
      "WORLD.zh.md": "# 中文世界观",
      "WORLD.en.md": "# English Lore",
    });

    const worlds = await loadWorldPackages(testDir);
    expect(worlds).toHaveLength(1);
    expect(worlds[0].lore).toEqual({
      "zh-CN": "# 中文世界观",
      "en-US": "# English Lore",
    });
  });

  it("should merge WORLD.md with locale-specific files", async () => {
    await createWorldFixture("mixed-lore", {
      "world.yaml": I18N_YAML,
      "WORLD.md": "# 默认世界观（不应覆盖 locale-specific）",
      "WORLD.zh.md": "# 中文世界观",
      "WORLD.en.md": "# English Lore",
    });

    const worlds = await loadWorldPackages(testDir);
    // Locale-specific files take precedence over WORLD.md
    expect(worlds[0].lore).toEqual({
      "zh-CN": "# 中文世界观",
      "en-US": "# English Lore",
    });
  });

  it("should use WORLD.md as fallback when no locale-specific file exists", async () => {
    await createWorldFixture("fallback-lore", {
      "world.yaml": I18N_YAML,
      "WORLD.md": "# 默认世界观",
      "WORLD.en.md": "# English Lore",
    });

    const worlds = await loadWorldPackages(testDir);
    // zh-CN gets WORLD.md (fallback), en-US gets WORLD.en.md
    expect(worlds[0].lore).toEqual({
      "zh-CN": "# 默认世界观",
      "en-US": "# English Lore",
    });
  });

  it("should have no lore if no WORLD files exist", async () => {
    await createWorldFixture("no-lore", {
      "world.yaml": MINIMAL_YAML,
    });

    const worlds = await loadWorldPackages(testDir);
    expect(worlds[0].lore).toBeUndefined();
  });
});

// ─── I18nText and dimensions ────────────────────────────────────────────────

describe("loadWorldPackages — i18n and dimensions", () => {
  it("should preserve I18nText name from manifest", async () => {
    await createWorldFixture("i18n-name", {
      "world.yaml": I18N_YAML,
    });

    const worlds = await loadWorldPackages(testDir);
    expect(worlds[0].name).toEqual({
      "zh-CN": "测试世界",
      "en-US": "Test World",
    });
  });

  it("should preserve dimensions from manifest", async () => {
    const yamlWithDims = `
schemaVersion: "1.0"
id: dims-world
name: Dims World
version: "0.1.0"
summary: World with dimensions
defaultLocale: zh-CN
supportedLocales: [zh-CN]
dimensions:
  tone:
    genres: [dark-fantasy]
    contentRating: teen
  startingConditions:
    openingScenario: 你站在门前。
    startingLocation: 大门
`;
    await createWorldFixture("dims-world", {
      "world.yaml": yamlWithDims,
    });

    const worlds = await loadWorldPackages(testDir);
    expect(worlds[0].dimensions).toBeDefined();
    expect(worlds[0].dimensions?.tone?.genres).toEqual(["dark-fantasy"]);
    expect(worlds[0].dimensions?.startingConditions?.openingScenario).toBe("你站在门前。");
  });

  it("should set locale from defaultLocale", async () => {
    await createWorldFixture("locale-world", {
      "world.yaml": MINIMAL_YAML,
    });

    const worlds = await loadWorldPackages(testDir);
    expect(worlds[0].locale).toBe("zh-CN");
  });

  it("should set tags from manifest", async () => {
    await createWorldFixture("tagged-world", {
      "world.yaml": I18N_YAML,
    });

    const worlds = await loadWorldPackages(testDir);
    expect(worlds[0].tags).toEqual(["test", "fantasy"]);
  });
});
