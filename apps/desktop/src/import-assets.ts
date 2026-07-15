/**
 * Import plugins and world packages from local files.
 *
 * Accepts either:
 *   - A directory path (copied recursively into the target user dir)
 *   - A .zip archive (extracted into the target user dir)
 *
 * Validation is intentionally strict:
 *   - Plugin imports require a PLUGIN.md at the root or inside runtimes/*
 *   - World imports require a world.yaml at the root
 *   - Zip entries are filtered for zip-slip / absolute paths / symlinks
 *     and capped against zip-bombs (see `zip-extract.ts`).
 *
 * The renderer never supplies a raw path: import is reached only through the
 * dialog-backed `covel:import:pick-{plugin,world}` channels, whose sourcePath
 * comes from a native file chooser in the main process.
 */

import fs from "node:fs";
import path from "node:path";
import { userPluginsDir, userWorldsDir } from "./paths.js";
import { extractZipSafely } from "./zip-extract.js";
import { t } from "./main-i18n.js";

export type ImportKind = "plugin" | "world";

export interface ImportResult {
  readonly ok: boolean;
  readonly kind: ImportKind;
  readonly targetPath?: string;
  readonly itemName?: string;
  readonly message?: string;
}

function isDirectorySafe(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFileSafe(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// ── Validators ─────────────────────────────────────────────────

function pluginMdExists(root: string): boolean {
  if (isFileSafe(path.join(root, "PLUGIN.md"))) return true;
  const runtimesDir = path.join(root, "runtimes");
  if (!isDirectorySafe(runtimesDir)) return false;
  for (const entry of fs.readdirSync(runtimesDir, { withFileTypes: true })) {
    if (
      entry.isDirectory() &&
      isFileSafe(path.join(runtimesDir, entry.name, "PLUGIN.md"))
    ) {
      return true;
    }
  }
  return false;
}

function worldYamlExists(root: string): boolean {
  return isFileSafe(path.join(root, "world.yaml"));
}

// ── Copy directory recursively ─────────────────────────────────

function copyDirRecursive(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    // Skip symlinks outright — we refuse to propagate them.
    if (entry.isSymbolicLink()) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(s, d);
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}

// ── Public API ─────────────────────────────────────────────────

export async function importAsset(
  kind: ImportKind,
  sourcePath: string,
): Promise<ImportResult> {
  if (!sourcePath)
    return { ok: false, kind, message: t("import.noSourcePath") };
  if (!fs.existsSync(sourcePath)) {
    return {
      ok: false,
      kind,
      message: t("import.sourceMissing", { sourcePath }),
    };
  }

  const targetRoot = kind === "plugin" ? userPluginsDir() : userWorldsDir();
  fs.mkdirSync(targetRoot, { recursive: true });

  const validate = kind === "plugin" ? pluginMdExists : worldYamlExists;

  // Branch: directory copy vs zip extraction
  if (isDirectorySafe(sourcePath)) {
    if (!validate(sourcePath)) {
      return {
        ok: false,
        kind,
        message:
          kind === "plugin"
            ? t("import.pluginMissingManifest")
            : t("import.worldMissingManifest"),
      };
    }
    const name = path.basename(sourcePath);
    const targetDir = path.join(targetRoot, name);
    if (fs.existsSync(targetDir)) {
      return {
        ok: false,
        kind,
        itemName: name,
        message: t("import.alreadyExists", { name }),
      };
    }
    copyDirRecursive(sourcePath, targetDir);
    return { ok: true, kind, targetPath: targetDir, itemName: name };
  }

  if (isFileSafe(sourcePath) && /\.zip$/i.test(sourcePath)) {
    // Extract to a temp dir first so we can validate before committing
    const tmpDir = fs.mkdtempSync(path.join(targetRoot, ".import-"));
    try {
      const { rootPrefix } = await extractZipSafely(sourcePath, tmpDir);
      const validateRoot = rootPrefix ? path.join(tmpDir, rootPrefix) : tmpDir;
      if (!validate(validateRoot)) {
        return {
          ok: false,
          kind,
          message:
            kind === "plugin"
              ? t("import.pluginZipMissingManifest")
              : t("import.worldZipMissingManifest"),
        };
      }
      const name = rootPrefix ?? path.basename(sourcePath, ".zip");
      const targetDir = path.join(targetRoot, name);
      if (fs.existsSync(targetDir)) {
        return {
          ok: false,
          kind,
          itemName: name,
          message: t("import.alreadyExists", { name }),
        };
      }
      // Move validated content into place. If rootPrefix, move that subdir,
      // otherwise move the whole tmp dir contents under a new dir.
      if (rootPrefix) {
        fs.renameSync(validateRoot, targetDir);
      } else {
        fs.renameSync(tmpDir, targetDir);
        return { ok: true, kind, targetPath: targetDir, itemName: name };
      }
      return { ok: true, kind, targetPath: targetDir, itemName: name };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        kind,
        message: t("import.failedWithReason", { reason: message }),
      };
    } finally {
      // Best-effort cleanup if tmpDir still exists
      try {
        if (fs.existsSync(tmpDir)) {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      } catch {
        /* ignore */
      }
    }
  }

  return {
    ok: false,
    kind,
    message: t("import.unsupportedSource"),
  };
}
