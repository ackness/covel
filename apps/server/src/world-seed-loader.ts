/**
 * World seed loader — reads worlds/ directory and upserts into the DataStore.
 *
 * Each world package has:
 *   world.yaml  — manifest (id, name, summary, dimensions, tags, …)
 *   WORLD.md    — default lore (fallback)
 *   WORLD.zh.md — Chinese lore (optional, locale-specific)
 *   WORLD.en-US.md — English lore (optional, locale-specific)
 *
 * Lore resolution: WORLD.<locale-prefix>.md → WORLD.md → empty string
 *
 * External dimension files:
 *   world.yaml `dimensionSources` maps dimension keys to relative file paths.
 *   Each file contains a validated dimension definition.
 *   Path traversal is prevented — all paths must resolve within the world directory.
 */

import { GENERATED_WORLD_MARKER } from "@covel/create";
import { worldRecordFromManifest } from "./world-data/world-record.js";
import { readReceipt } from "./routes/api/install/package-files.js";
import type { SessionLock } from "./lib/session-lock.js";
import { isWorldDeleting, worldOperationLockId } from "./world-lifecycle.js";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  validateWorldManifest,
  validateDimensionData,
  formatValidationErrors,
  dimensionIdSchema,
  localeLookupCandidates,
  WORLD_LOCALIZED_TEXT_KEY,
} from "@covel/shared";
import type { DataStore, WorldRecord } from "@covel/store";
import { resolveContainedPath } from "./world-data/safe-path.js";
import {
  compileLocaleOverlays,
  readWorldManifestSource,
} from "./world-data/locale-overlays.js";
import { loadWorldDataSummary } from "./world-data/world-load.js";
import type { WorldDataDiagnostic } from "./world-data/types.js";
import {
  fileExists,
  readWorldManifest,
} from "./world-data/session-import/utils.js";

/**
 * Resolve a locale-aware file inside the world directory.
 * Priority: exact canonical locale → compatible primary language → base file.
 */
export async function resolveLocaleFilePath(
  worldDir: string,
  relativePath: string,
  defaultLocale?: string,
): Promise<string | null> {
  const parsed = path.parse(relativePath);
  for (const locale of localeLookupCandidates(defaultLocale)) {
    const localePath = path.join(
      parsed.dir,
      `${parsed.name}.${locale}${parsed.ext}`,
    );
    const safePath = await resolveSafePath(worldDir, localePath);
    if (safePath && (await fileExists(safePath))) return safePath;
  }

  const safePath = await resolveSafePath(worldDir, relativePath);
  return safePath && (await fileExists(safePath)) ? safePath : null;
}

/** Read locale-aware WORLD.md lore without allowing the locale into a path. */
async function readLore(
  worldDir: string,
  defaultLocale?: string,
): Promise<string> {
  const resolvedPath = await resolveLocaleFilePath(
    worldDir,
    "WORLD.md",
    defaultLocale,
  );
  return resolvedPath ? readFile(resolvedPath, "utf-8") : "";
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
 * Load external dimension files referenced by `dimensionSources` in world.yaml.
 * Each file contains one dimension definition (name, schema, initialValue, rule).
 * External files take precedence over inline dimensions for the same key.
 *
 * Translations: `<name>.<locale>.<ext>` beside a file is a sparse overlay of
 * it. Every overlay is compiled into locale maps; `defaultLocale` names the
 * language of the main file.
 */
export async function loadExternalDimensions(
  worldDir: string,
  sources: Record<string, string>,
  worldId: string,
  defaultLocale?: string,
  /**
   * Optional sink for the specific failure reason. Session import surfaces
   * these to the author instead of a bare "sources failed validation".
   */
  onDiagnostic?: (message: string) => void,
): Promise<Record<string, unknown> | null> {
  const result: Record<string, unknown> = {};
  const fail = (message: string): null => {
    console.warn(message);
    onDiagnostic?.(message);
    return null;
  };

  for (const [key, relativePath] of Object.entries(sources)) {
    // Validate dimension key
    if (!dimensionIdSchema.safeParse(key).success) {
      return fail(
        `[world-seed] ${worldId}: invalid dimension ID "${key}" in dimensionSources`,
      );
    }

    // Path traversal check on the declared path
    if (!(await resolveSafePath(worldDir, relativePath))) {
      return fail(
        `[world-seed] ${worldId}: path traversal detected for "${key}": ${relativePath}`,
      );
    }

    const resolvedPath = await resolveSafePath(worldDir, relativePath);
    if (!resolvedPath || !(await fileExists(resolvedPath))) {
      return fail(
        `[world-seed] ${worldId}: dimension file not found for "${key}": ${relativePath}`,
      );
    }

    try {
      const content = await readFile(resolvedPath, "utf-8");
      // `<name>.<locale>.<ext>` beside the file holds its translations.
      const compiled = await compileLocaleOverlays({
        root: worldDir,
        relativePath,
        base: parseYaml(content),
        baseLocale: defaultLocale,
      });
      for (const issue of compiled.issues)
        console.warn(
          `[world-seed] ${worldId}: ${issue.file}: ${issue.path} ${issue.message}`,
        );
      const data = compiled.value;

      // All authored dimensions use the same definition contract.
      const validation = validateDimensionData(key, data);
      if (!validation.valid) {
        return fail(
          `[world-seed] ${worldId}: invalid dimension file "${relativePath}" for "${key}":\n${formatValidationErrors(validation.errors!)}`,
        );
      }

      result[key] = validation.data;
    } catch (err) {
      return fail(
        `[world-seed] ${worldId}: failed to load dimension file "${relativePath}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return result;
}

/**
 * Load a single world package from its directory.
 * Returns a WorldRecord ready for upsert, or null if invalid/missing.
 */
export async function loadSingleWorld(
  worldDir: string,
  options?: {
    source?: string;
    covelHome?: string;
    includeWorldDataOverrides?: boolean;
    /** Installers may reject errors; seed loading remains tolerant by default. */
    onWorldDataDiagnostics?: (
      diagnostics: readonly WorldDataDiagnostic[],
    ) => void;
    storage?: Record<string, unknown>;
  },
): Promise<WorldRecord | null> {
  const yamlPath = await resolveSafePath(worldDir, "world.yaml");
  if (!yamlPath) return null;

  // The main file is one language; `world.<locale>.yaml` overlays add the
  // translations, compiled here into locale maps for the catalog.
  const source = await readWorldManifestSource(worldDir);
  for (const issue of source.issues)
    console.warn(
      `[world-seed] ${path.basename(worldDir)}: ${issue.file}: ${issue.path} ${issue.message}`,
    );
  const raw = source.raw as Record<string, unknown>;

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
  // A declared source is required. Partial reads must not erase the last
  // valid dimensions or authorize reconciliation against an incomplete scan.
  if (externalDims === null) return null;
  const mergedDimensions = { ...inlineDims, ...externalDims };

  const lore = await readLore(worldDir, defaultLocale);
  const loreEditions = Object.fromEntries(
    await Promise.all(
      [
        ...new Set([
          defaultLocale,
          ...((manifest.supportedLocales as string[] | undefined) ?? []),
        ]),
      ]
        .filter((locale): locale is string => typeof locale === "string")
        .map(
          async (locale) => [locale, await readLore(worldDir, locale)] as const,
        ),
    ),
  );
  const now = new Date().toISOString();

  const packageReceipt = await readReceipt(worldDir).catch(() => null);
  const baseRecord = worldRecordFromManifest(
    manifest,
    lore,
    {
      ...(packageReceipt
        ? {
            packageManaged: true,
            storage: {
              scope: "server",
              backend: "file",
              path: path.dirname(worldDir),
              durable: true,
            },
          }
        : {}),
      source: options?.source ?? (packageReceipt ? "generated-file" : "file"),
      ...(options?.storage ? { storage: options.storage } : {}),
      // Written by the world generator: the app may rewrite this package.
      ...((await fileExists(path.join(worldDir, GENERATED_WORLD_MARKER)))
        ? { generated: true }
        : {}),
      dimensions:
        Object.keys(mergedDimensions).length > 0 ? mergedDimensions : undefined,
    },
    now,
  );
  const worldData = await loadWorldDataSummary({
    worldRoot: worldDir,
    covelHome: options?.covelHome,
    includeOverrides: options?.includeWorldDataOverrides,
    worldId,
    worldDataPath,
    defaultLocale,
    metadata: {
      ...baseRecord.metadata,
      [WORLD_LOCALIZED_TEXT_KEY]: {
        ...(baseRecord.metadata?.[WORLD_LOCALIZED_TEXT_KEY] as
          Record<string, unknown> | undefined),
        lore: loreEditions,
      },
    },
    now,
  });
  for (const diagnostic of worldData.diagnostics) {
    if (diagnostic.level === "error") {
      console.warn(
        `[world-seed] ${worldId}: worldData ${diagnostic.sourceId ? `${diagnostic.sourceId}: ` : ""}${diagnostic.message}`,
      );
    }
  }

  options?.onWorldDataDiagnostics?.(worldData.diagnostics);
  return { ...baseRecord, metadata: worldData.metadata };
}

/**
 * Discover and load all world packages from a directory.
 * Validates each world.yaml against worldManifestSchema.
 * Inventories package identities; content is loaded after world-lock admission.
 */
async function loadWorldPackages(worldsDir: string): Promise<{
  packages: { id: string; directory: string }[];
  worldIds: string[];
  complete: boolean;
}> {
  const entries = await readdir(worldsDir, { withFileTypes: true });
  const packages: { id: string; directory: string }[] = [];
  const identityCounts = new Map<string, number>();
  let complete = true;

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;

    const worldDir = path.join(worldsDir, entry.name);

    try {
      // Containers such as _archive are not world packages. Other access
      // errors must propagate so a failed inventory cannot authorize deletion.
      try {
        await access(path.join(worldDir, "world.yaml"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const manifestPath = await resolveSafePath(worldDir, "world.yaml");
      if (!manifestPath) {
        complete = false;
        continue;
      }
      const { id } = await readWorldManifest(worldDir);
      if (id) {
        identityCounts.set(id, (identityCounts.get(id) ?? 0) + 1);
        packages.push({ id, directory: worldDir });
      } else complete = false;
    } catch (err) {
      complete = false;
      console.warn(`[world-seed] Failed to load world ${entry.name}:`, err);
    }
  }

  const uniquePackages = packages.filter((record) => {
    if (identityCounts.get(record.id) === 1) return true;
    complete = false;
    console.warn(
      `[world-seed] Duplicate world id "${record.id}"; keeping stored state.`,
    );
    return false;
  });
  return {
    packages: uniquePackages,
    worldIds: [...identityCounts.keys()],
    complete,
  };
}

/**
 * Seed all world packages into the DataStore (idempotent via upsert).
 * Reports whether every discovered package loaded successfully. Only a complete
 * inventory across all roots can authorize reconciliation of stale DB records.
 */
export async function seedWorlds(
  store: DataStore,
  worldsDir: string,
  sessionLock: SessionLock,
  excludedWorldIds: ReadonlySet<string> = new Set(),
): Promise<{ worldIds: string[]; complete: boolean }> {
  const inventory = await loadWorldPackages(worldsDir);
  let complete = inventory.complete;
  const loaded: string[] = [];
  for (const entry of inventory.packages) {
    if (excludedWorldIds.has(entry.id)) continue;
    try {
      await sessionLock.withLock(worldOperationLockId(entry.id), async () => {
        const existing = await store.getWorld(entry.id);
        if (existing && isWorldDeleting(existing)) return;
        // Read content only after admission. A package removed while this seed
        // waited cannot be reconstructed from a stale inventory record.
        const record = await loadSingleWorld(entry.directory);
        if (!record || record.id !== entry.id) {
          complete = false;
          return;
        }
        await store.upsertWorld(
          preserveWorldProvenance(record, existing ?? undefined),
        );
        loaded.push(record.id);
      });
    } catch (error) {
      complete = false;
      console.warn(`[world-seed] Failed to load world ${entry.id}:`, error);
    }
  }
  if (loaded.length > 0) {
    console.log(
      `[world-seed] Loaded ${loaded.length} world(s): ${loaded.join(", ")}`,
    );
  }
  return { worldIds: inventory.worldIds, complete };
}

/** Disk content does not own a world's origin, storage binding, or creation date. */
export function preserveWorldProvenance(
  record: WorldRecord,
  existing: WorldRecord | undefined,
): WorldRecord {
  if (!existing) return record;
  // Editor changes live in the store; a package refresh must not erase them.
  if (existing.metadata?.packageManaged && existing.metadata.packageModified)
    return existing;
  const { source, storage } = existing.metadata ?? {};
  return {
    ...record,
    createdAt: existing.createdAt,
    metadata: {
      ...record.metadata,
      ...(source === undefined ? {} : { source }),
      ...(storage === undefined ? {} : { storage }),
    },
  };
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
 *  3. **Inventory guard (caller)** — skip when any root/package failed to load
 *     or no world was seeded. A partial successful set is not a removal list.
 */
export async function reconcileSeededWorlds(
  store: DataStore,
  liveWorldIds: ReadonlySet<string>,
  sessionLock: SessionLock,
): Promise<WorldReconcileResult> {
  const removed: string[] = [];
  const keptWithSessions: string[] = [];
  const worlds = await store.listWorlds();

  for (const world of worlds) {
    if (liveWorldIds.has(world.id)) continue;
    await sessionLock.withLock(worldOperationLockId(world.id), async () => {
      const live = await store.getWorld(world.id);
      if (!live || live.metadata?.source !== "file" || isWorldDeleting(live))
        return;
      const sessions = await store.listSessions();
      if (sessions.some((session) => session.worldId === world.id)) {
        keptWithSessions.push(world.id);
        return;
      }
      await store.deleteWorld(world.id);
      removed.push(world.id);
    });
  }

  return { removed, keptWithSessions };
}
