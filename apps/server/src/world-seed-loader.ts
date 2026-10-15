/**
 * World seed loader — reads worlds/ directory and upserts into the DataStore.
 *
 * Each world package has:
 *   world.yaml  — manifest (name, summary, defaultLocale, tags, …; the ID is
 *                 the directory name unless `id` is written)
 *   WORLD.md    — default lore (fallback)
 *   WORLD.en-US.md — English lore (optional; with `world.en-US.yaml` it is
 *                    what gives the world an `en-US` edition)
 *
 * Lore resolution: WORLD.<defaultLocale>.md → WORLD.md → empty string
 */

import { readGeneratedWorldMarker } from "@covel/create";
import { worldRecordFromManifest } from "./world-data/world-record.js";
import { worldPackageDigest } from "./world-data/package-digest.js";
import { readReceipt } from "./routes/api/install/package-files.js";
import type { SessionLock } from "./lib/session-lock.js";
import { isWorldDeleting, worldOperationLockId } from "./world-lifecycle.js";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  validateWorldManifest,
  worldAccentColorSchema,
  formatValidationErrors,
  canonicalizeLocale,
  WORLD_EDITIONS_KEY,
  WORLD_LOCALIZED_TEXT_KEY,
} from "@covel/shared";
import type { DataStore, WorldRecord } from "@covel/store";
import { resolveContainedPath } from "./world-data/safe-path.js";
import {
  findMisnamedLocaleFiles,
  misnamedLocaleMessage,
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
 * Priority: the file named with `defaultLocale` exactly → base file. A
 * translation file is named with the locale of its edition, and a session
 * reads an edition the world has, so a bare language (`WORLD.en.md` for
 * `en-US`) is never tried.
 */
export async function resolveLocaleFilePath(
  worldDir: string,
  relativePath: string,
  defaultLocale?: string,
): Promise<string | null> {
  const parsed = path.parse(relativePath);
  const locale = canonicalizeLocale(defaultLocale);
  if (locale) {
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
  const packageDigest = await worldPackageDigest(worldDir);

  // The main file is one language; `world.<locale>.yaml` overlays add the
  // translations, compiled here into locale maps for the catalog.
  const source = await readWorldManifestSource(worldDir);
  for (const issue of source.issues)
    console.warn(
      `[world-seed] ${path.basename(worldDir)}: ${issue.file}: ${issue.path} ${issue.message}`,
    );
  let raw = source.raw as Record<string, unknown>;
  // Optional presentation metadata must not prevent the world from loading.
  // Keep authoring validation strict; only the loader discards a bad accent.
  if (raw?.accentColor !== undefined) {
    const accent = worldAccentColorSchema.safeParse(raw.accentColor);
    if (!accent.success) {
      const world =
        typeof raw.id === "string" ? raw.id : path.basename(worldDir);
      console.warn(
        `[world-seed] ${world}: world.yaml: accentColor ignored: ${accent.error.issues.map((issue) => issue.message).join("; ")} Using the default accent colour.`,
      );
      raw = { ...raw };
      delete raw.accentColor;
    }
  }

  const validation = validateWorldManifest(raw, {
    ignoreUnknownRootFields: true,
  });
  for (const field of validation.ignoredFields ?? [])
    console.warn(
      `[world-seed] ${path.basename(worldDir)}: world.yaml: ${field}: unknown field ignored`,
    );
  if (validation.droppedSections?.length)
    console.warn(
      `[world-seed] ${path.basename(worldDir)}: world.yaml: pluginPolicy ignored; sessions start with the plugins every session has:\n${formatValidationErrors(validation.droppedSections)}`,
    );
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
  const worldDataPath = manifest.worldData as string | undefined;
  const editions = source.editions;
  const inlineDimensions =
    (manifest.dimensions as Record<string, unknown>) ?? {};

  const lore = await readLore(worldDir, defaultLocale);
  const loreEditions = Object.fromEntries(
    await Promise.all(
      editions.map(
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
      ...(packageDigest ? { packageDigest } : {}),
      ...(options?.storage ? { storage: options.storage } : {}),
      // Written by the world generator: the app may rewrite this package
      // while it holds only the files the marker lists.
      ...((await readGeneratedWorldMarker(worldDir))
        ? { generated: true }
        : {}),
      dimensions:
        Object.keys(inlineDimensions).length > 0 ? inlineDimensions : undefined,
      // The locales the world has content for; a session is in one of them.
      ...(editions.length > 1 ? { [WORLD_EDITIONS_KEY]: editions } : {}),
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

  // A translation file named with a bare language is never read. The seed
  // loader only says so; an installer rejects the package on the error.
  const misnamed = await findMisnamedLocaleFiles(worldDir, editions);
  const misnamedDiagnostics: WorldDataDiagnostic[] = misnamed.map((item) => ({
    level: "error",
    path: item.file,
    message: `${misnamedLocaleMessage(item)}; the file is ignored`,
    hint: `Rename it to \`${item.renamed}\`. A translation file names the locale of its edition exactly.`,
  }));
  for (const item of misnamed)
    console.warn(
      `[world-seed] ${worldId}: ${item.file} is ignored: ${misnamedLocaleMessage(item)}. Rename it to ${item.renamed}.`,
    );

  options?.onWorldDataDiagnostics?.([
    ...worldData.diagnostics,
    ...misnamedDiagnostics,
  ]);
  if (
    worldData.summary?.sources.some(
      (source) =>
        source.target === "world:metadata.dimensions" &&
        source.diagnostics.error > 0,
    )
  )
    return null;
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
  const entries = await readdir(worldsDir, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      // A fresh installation need not have a user worlds directory yet.
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
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
  // The record is the world. Once the player edits it in the app, a package
  // refresh must not replace it; only an explicit restore does.
  if (existing.metadata?.packageModified) return existing;
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
 *  1. **Origin gate** — only unedited `metadata.source === "file"` worlds are eligible.
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
      if (
        !live ||
        live.metadata?.source !== "file" ||
        live.metadata.packageModified ||
        isWorldDeleting(live)
      )
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
