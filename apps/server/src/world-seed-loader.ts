/**
 * World seed loader — reads worlds/ directory and upserts into the DataStore.
 *
 * Each world package has:
 *   world.yaml  — manifest (id, name, summary, dimensions, tags, …)
 *   WORLD.md    — default lore (fallback)
 *   WORLD.zh.md — Chinese lore (optional, locale-specific)
 *   WORLD.en.md — English lore (optional, locale-specific)
 *
 * Lore resolution: WORLD.<locale-prefix>.md → WORLD.md → empty string
 *
 * External dimension files:
 *   world.yaml `dimensionSources` maps dimension keys to relative file paths.
 *   Each file is validated against the corresponding sub-schema.
 *   Path traversal is prevented — all paths must resolve within the world directory.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  validateWorldManifest,
  validateDimensionData,
  formatValidationErrors,
  DIMENSION_KEYS,
} from "@covel/shared";
import type { MemoryBlockSchema } from "@covel/shared";
import type { DataStore, WorldRecord } from "@covel/store";
import { resolveContainedPath } from "./world-data/safe-path.js";
import { loadWorldDataSummary } from "./world-data/world-load.js";
import { fileExists } from "./world-data/session-import/utils.js";

/**
 * Resolve a single I18nText field to a plain display string.
 * If the value is a Record, pick `defaultLocale` key → first key → empty.
 */
function resolveText(
  value: string | Record<string, string> | undefined,
  defaultLocale?: string,
): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (defaultLocale && value[defaultLocale]) return value[defaultLocale];
  const keys = Object.keys(value);
  return keys.length > 0 ? value[keys[0]] : "";
}

/**
 * Read locale-aware WORLD.md lore file.
 * Priority: WORLD.<lang>.md → WORLD.md → ''
 */
async function readLore(
  worldDir: string,
  defaultLocale?: string,
): Promise<string> {
  const lang = defaultLocale?.split("-")[0]; // "zh-CN" → "zh"

  // Try locale-specific first
  if (lang) {
    const localePath = path.join(worldDir, `WORLD.${lang}.md`);
    if (await fileExists(localePath)) {
      return readFile(localePath, "utf-8");
    }
  }

  // Fallback to default WORLD.md
  const defaultPath = path.join(worldDir, "WORLD.md");
  if (await fileExists(defaultPath)) {
    return readFile(defaultPath, "utf-8");
  }

  return "";
}

/**
 * Validate that a relative path does not escape the world directory.
 * Returns the resolved absolute path if safe, or null if path traversal detected.
 */
async function resolveSafePath(
  worldDir: string,
  relativePath: string,
): Promise<string | null> {
  return resolveContainedPath(worldDir, relativePath, {
    rejectSymlinks: true,
  });
}

/**
 * Resolve a locale-aware dimension file path.
 * Priority: <name>.<lang>.<ext> → <name>.<ext> (same as WORLD.md resolution)
 *
 * Example: geography.yaml with defaultLocale="zh-CN"
 *   → tries geography.zh.yaml first, then geography.yaml
 */
async function resolveLocaleDimensionPath(
  worldDir: string,
  relativePath: string,
  defaultLocale?: string,
): Promise<string | null> {
  const lang = defaultLocale?.split("-")[0]; // "zh-CN" → "zh"

  if (lang) {
    const parsed = path.parse(relativePath);
    // e.g., "./dimensions/geography.yaml" → "./dimensions/geography.zh.yaml"
    const localePath = path.join(
      parsed.dir,
      `${parsed.name}.${lang}${parsed.ext}`,
    );
    const safePath = await resolveSafePath(worldDir, localePath);
    if (safePath && (await fileExists(safePath))) {
      return safePath;
    }
  }

  // Fallback to original path
  const safePath = await resolveSafePath(worldDir, relativePath);
  if (safePath && (await fileExists(safePath))) {
    return safePath;
  }

  return null;
}

/**
 * Load external dimension files referenced by `dimensionSources` in world.yaml.
 * Each file contains the data for a single dimension key (e.g., geography.yaml → WorldGeography).
 * External files take precedence over inline dimensions for the same key.
 *
 * Locale resolution: for each source path, tries `<name>.<lang>.<ext>` first
 * (e.g., `geography.zh.yaml`), then falls back to the declared path.
 */
async function loadExternalDimensions(
  worldDir: string,
  sources: Record<string, string>,
  worldId: string,
  defaultLocale?: string,
): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};

  for (const [key, relativePath] of Object.entries(sources)) {
    // Validate dimension key
    if (!DIMENSION_KEYS.includes(key)) {
      console.warn(
        `[world-seed] ${worldId}: unknown dimension key "${key}" in dimensionSources, skipping`,
      );
      continue;
    }

    // Path traversal check on the declared path
    if (!(await resolveSafePath(worldDir, relativePath))) {
      console.warn(
        `[world-seed] ${worldId}: path traversal detected for "${key}": ${relativePath}, skipping`,
      );
      continue;
    }

    // Resolve with locale awareness
    const resolvedPath = await resolveLocaleDimensionPath(
      worldDir,
      relativePath,
      defaultLocale,
    );
    if (!resolvedPath) {
      console.warn(
        `[world-seed] ${worldId}: dimension file not found for "${key}": ${relativePath}`,
      );
      continue;
    }

    try {
      const content = await readFile(resolvedPath, "utf-8");
      const data = parseYaml(content);

      // Validate against dimension-specific sub-schema
      const validation = validateDimensionData(key, data);
      if (!validation.valid) {
        console.warn(
          `[world-seed] ${worldId}: invalid dimension file "${relativePath}" for "${key}":\n${formatValidationErrors(validation.errors!)}`,
        );
        continue;
      }

      result[key] = validation.data;
    } catch (err) {
      console.warn(
        `[world-seed] ${worldId}: failed to load dimension file "${relativePath}":`,
        err,
      );
    }
  }

  return result;
}

/**
 * Fold the deprecated top-level `requiredPlugins` / `recommendedPlugins` /
 * `excludedPlugins` into `pluginPolicy` (union, de-duplicated) so metadata
 * carries plugin selection in exactly one place — the prep page reads selection
 * only through `pluginPolicy`. The top-level fields stay valid in `world.yaml`
 * for back-compat but are no longer stored as separate metadata keys.
 * Returns undefined when neither source declares anything.
 */
function foldSelectionIntoPluginPolicy(
  manifest: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const rawPolicy = manifest.pluginPolicy as
    Record<string, unknown> | undefined;
  const folded: Record<string, unknown> = { ...rawPolicy };
  let hasSelection = rawPolicy !== undefined;
  for (const key of [
    "requiredPlugins",
    "recommendedPlugins",
    "excludedPlugins",
  ] as const) {
    const top = Array.isArray(manifest[key]) ? (manifest[key] as string[]) : [];
    const inPolicy = Array.isArray(rawPolicy?.[key])
      ? (rawPolicy![key] as string[])
      : [];
    const merged = [...new Set([...inPolicy, ...top])];
    if (merged.length > 0) {
      folded[key] = merged;
      hasSelection = true;
    }
  }
  return hasSelection ? folded : undefined;
}

/**
 * Load a single world package from its directory.
 * Returns a WorldRecord ready for upsert, or null if invalid/missing.
 */
export async function loadSingleWorld(
  worldDir: string,
  options?: {
    source?: string;
    storage?: Record<string, unknown>;
  },
): Promise<WorldRecord | null> {
  const yamlPath = path.join(worldDir, "world.yaml");

  if (!(await fileExists(yamlPath))) return null;

  const yamlContent = await readFile(yamlPath, "utf-8");
  const raw = parseYaml(yamlContent) as Record<string, unknown>;

  const validation = validateWorldManifest(raw);
  if (!validation.valid) {
    const dirName = path.basename(worldDir);
    console.warn(
      `[world-seed] Invalid world.yaml in ${dirName}:\n${formatValidationErrors(validation.errors!)}`,
    );
    return null;
  }

  const manifest = validation.data as Record<string, unknown>;
  const worldId = manifest.id as string;
  const defaultLocale = manifest.defaultLocale as string | undefined;
  const dimensionSources = manifest.dimensionSources as
    Record<string, string> | undefined;
  const worldDataPath = manifest.worldData as string | undefined;
  const pluginPolicy = foldSelectionIntoPluginPolicy(manifest);
  const pluginSettings = manifest.pluginSettings as
    Record<string, Record<string, unknown>> | undefined;
  const memoryBlocks = manifest.memoryBlocks as
    readonly MemoryBlockSchema[] | undefined;
  const defaultViewMode = manifest.defaultViewMode as string | undefined;

  // Merge inline + external dimensions (external wins for same key)
  const inlineDims = (manifest.dimensions as Record<string, unknown>) ?? {};
  const externalDims = dimensionSources
    ? await loadExternalDimensions(
        worldDir,
        dimensionSources,
        worldId,
        defaultLocale,
      )
    : {};
  const mergedDimensions = { ...inlineDims, ...externalDims };

  const lore = await readLore(worldDir, defaultLocale);
  const now = new Date().toISOString();

  const characterBlueprintSources = Array.isArray(
    manifest.characterBlueprintSources,
  )
    ? (manifest.characterBlueprintSources as string[])
    : undefined;
  const characterBlueprints =
    characterBlueprintSources && !worldDataPath
      ? await loadCharacterBlueprints(worldDir, characterBlueprintSources)
      : undefined;

  // World-declared character attribute schema (optional). Carried into
  // metadata so `world-init`'s guard can write it verbatim and skip the LLM.
  const characterAttributes = Array.isArray(manifest.characterAttributes)
    ? (manifest.characterAttributes as unknown[])
    : undefined;

  const baseMetadata: Record<string, unknown> = {
    source: options?.source ?? "file",
    ...(options?.storage ? { storage: options.storage } : {}),
    dimensions:
      Object.keys(mergedDimensions).length > 0 ? mergedDimensions : undefined,
    dimensionSources: dimensionSources,
    pluginPolicy,
    pluginSettings,
    memoryBlocks,
    worldDataPath,
    characterBlueprintSources,
    characterBlueprints,
    characterAttributes,
    ...(defaultViewMode ? { defaultViewMode } : {}),
  };
  const worldData = await loadWorldDataSummary({
    worldRoot: worldDir,
    worldId,
    worldDataPath,
    metadata: baseMetadata,
    now,
  });
  for (const diagnostic of worldData.diagnostics) {
    if (diagnostic.level === "error") {
      console.warn(
        `[world-seed] ${worldId}: worldData ${diagnostic.sourceId ? `${diagnostic.sourceId}: ` : ""}${diagnostic.message}`,
      );
    }
  }

  return {
    id: worldId,
    name: resolveText(
      manifest.name as string | Record<string, string>,
      defaultLocale,
    ),
    description: resolveText(
      manifest.summary as string | Record<string, string> | undefined,
      defaultLocale,
    ),
    lore: lore || undefined,
    tags: manifest.tags as string[] | undefined,
    locale: defaultLocale,
    metadata: worldData.metadata,
    createdAt: now,
    updatedAt: now,
  };
}

async function loadCharacterBlueprints(
  worldDir: string,
  sources: readonly string[],
): Promise<unknown[]> {
  const blueprints: unknown[] = [];
  for (const source of sources) {
    const fullPath = await resolveSafePath(worldDir, source);
    if (!fullPath) {
      throw new Error(
        `characterBlueprintSources path escapes world dir: ${source}`,
      );
    }
    const raw = await readFile(fullPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) blueprints.push(...parsed);
    else blueprints.push(parsed);
  }
  return blueprints;
}

/**
 * Discover and load all world packages from a directory.
 * Validates each world.yaml against worldManifestSchema.
 * Returns WorldRecord[] ready for upsert.
 */
async function loadWorldPackages(worldsDir: string): Promise<WorldRecord[]> {
  if (!(await fileExists(worldsDir))) return [];

  const entries = await readdir(worldsDir, { withFileTypes: true });
  const records: WorldRecord[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const worldDir = path.join(worldsDir, entry.name);

    try {
      const record = await loadSingleWorld(worldDir);
      if (record) records.push(record);
    } catch (err) {
      console.warn(`[world-seed] Failed to load world ${entry.name}:`, err);
    }
  }

  return records;
}

/**
 * Seed all world packages into the DataStore (idempotent via upsert).
 * Returns the ids of the worlds loaded from this directory so callers can build
 * the set of "live" worlds across every source and reconcile stale DB records.
 */
export async function seedWorlds(
  store: DataStore,
  worldsDir: string,
): Promise<string[]> {
  const records = await loadWorldPackages(worldsDir);

  for (const record of records) {
    await store.upsertWorld(record);
  }

  if (records.length > 0) {
    console.log(
      `[world-seed] Loaded ${records.length} world(s): ${records.map((r) => r.id).join(", ")}`,
    );
  }

  return records.map((r) => r.id);
}

export interface WorldReconcileResult {
  /** Worlds removed from the DB because their package is gone and they had no sessions. */
  removed: string[];
  /** Stale worlds kept because they still have saved sessions (never silently deleted). */
  keptWithSessions: string[];
}

/**
 * Reconcile DB world records against the worlds actually present on disk.
 *
 * `seedWorlds` only ever upserts, so a world that was file-seeded in a previous
 * release and later archived (removed from the bundle) lingers in every existing
 * user's DB and keeps showing up in the world list. This drops those stragglers.
 *
 * Safety rails — this only ever removes data it is certain is a dead seed:
 *  1. **Origin gate** — only `metadata.source === "file"` worlds are eligible.
 *     AI-generated worlds (`generated` / `generated-file`) and any other origin
 *     are never touched, even when absent from `liveWorldIds`.
 *  2. **Save protection** — a stale world that still has saved sessions is KEPT
 *     and reported in `keptWithSessions`; deleting a player's saves is left to an
 *     explicit action, never a silent boot-time sweep.
 *  3. **Empty-set guard (caller)** — the caller must skip this entirely when no
 *     world was seeded, so a transient load failure can never wipe the DB.
 */
export async function reconcileSeededWorlds(
  store: DataStore,
  liveWorldIds: ReadonlySet<string>,
): Promise<WorldReconcileResult> {
  const removed: string[] = [];
  const keptWithSessions: string[] = [];
  const worlds = await store.listWorlds();
  let sessions: { worldId?: string }[] | null = null;

  for (const world of worlds) {
    if (liveWorldIds.has(world.id)) continue;
    const source = (world.metadata as Record<string, unknown> | undefined)
      ?.source;
    if (source !== "file") continue;

    if (!sessions) sessions = await store.listSessions();
    if (sessions.some((s) => s.worldId === world.id)) {
      keptWithSessions.push(world.id);
      continue;
    }

    await store.deleteWorld(world.id);
    removed.push(world.id);
  }

  return { removed, keptWithSessions };
}
