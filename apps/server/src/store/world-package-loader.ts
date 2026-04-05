/**
 * World Package Loader
 *
 * Scans a directory for world package subdirectories, each containing:
 * - world.yaml   — manifest (WorldPackageMeta) + inline dimensions
 * - WORLD.md     — default-locale lore (fallback)
 * - WORLD.zh.md  — locale-specific lore (zh-CN)
 * - WORLD.en.md  — locale-specific lore (en-US)
 *
 * Returns WorldRecord[] for store seeding.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { worldPackageMetaSchema } from "@covel/shared";
import type { WorldRecord } from "@covel/store";

/** Short lang code → BCP-47 locale mapping. */
const LANG_TO_LOCALE: Record<string, string> = {
  zh: "zh-CN",
  en: "en-US",
  ja: "ja-JP",
  ko: "ko-KR",
};

/**
 * Scan a directory for WORLD.md / WORLD.{lang}.md files
 * and assemble an i18n lore map.
 */
async function loadLoreFiles(
  dir: string,
  defaultLocale: string,
): Promise<Record<string, string> | undefined> {
  const entries = await readdir(dir);
  const loreMap: Record<string, string> = {};
  let defaultLore: string | undefined;

  for (const entry of entries) {
    // Match WORLD.md or WORLD.{lang}.md (case-sensitive)
    if (!entry.startsWith("WORLD") || !entry.endsWith(".md")) continue;

    const content = await readFile(join(dir, entry), "utf-8");

    if (entry === "WORLD.md") {
      defaultLore = content;
    } else {
      // Extract lang from WORLD.{lang}.md
      const match = entry.match(/^WORLD\.([a-z]+)\.md$/);
      if (match) {
        const lang = match[1];
        const locale = LANG_TO_LOCALE[lang] ?? lang;
        loreMap[locale] = content;
      }
    }
  }

  // WORLD.md serves as fallback for defaultLocale if no locale-specific file
  if (defaultLore && !loreMap[defaultLocale]) {
    loreMap[defaultLocale] = defaultLore;
  }

  return Object.keys(loreMap).length > 0 ? loreMap : undefined;
}

/**
 * Load all world packages from a directory.
 *
 * Each subdirectory with a valid `world.yaml` becomes a WorldRecord.
 * Invalid packages are silently skipped (logged in production).
 */
export async function loadWorldPackages(
  worldsDir: string,
): Promise<WorldRecord[]> {
  let entries: string[];
  try {
    entries = await readdir(worldsDir);
  } catch {
    // Directory doesn't exist — return empty
    return [];
  }

  const results: WorldRecord[] = [];

  for (const entry of entries) {
    const dir = join(worldsDir, entry);

    // Skip non-directories
    try {
      const s = await stat(dir);
      if (!s.isDirectory()) continue;
    } catch {
      continue;
    }

    // Read world.yaml
    let yamlContent: string;
    try {
      yamlContent = await readFile(join(dir, "world.yaml"), "utf-8");
    } catch {
      // No world.yaml — skip
      continue;
    }

    // Parse YAML and validate
    let parsed: unknown;
    try {
      parsed = parseYaml(yamlContent);
    } catch {
      continue;
    }

    const validation = worldPackageMetaSchema.safeParse(parsed);
    if (!validation.success) {
      // Log validation errors for debugging (silent skip in production)
      if (process.env.NODE_ENV === "test" || process.env.DEBUG) {
        const issues = validation.error.issues.slice(0, 5).map(
          (i) => `${i.path.join(".")}: ${i.message}`,
        );
        console.warn(`[world-package-loader] Skipping ${entry}: ${issues.join("; ")}`);
      }
      continue;
    }

    const meta = validation.data;

    // Load lore files
    const lore = await loadLoreFiles(dir, meta.defaultLocale);

    const now = new Date().toISOString();
    results.push({
      id: `world_${meta.id}`,
      packageId: meta.id,
      name: meta.name,
      description: meta.summary,
      lore,
      locale: meta.defaultLocale,
      tags: meta.tags,
      dimensions: meta.dimensions,
      createdAt: now,
    });
  }

  return results;
}
