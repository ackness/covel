import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  emptySettingsPersistenceBundle,
  nextSettingsPersistenceBundle,
  parseSettingsPersistenceBundle,
  type SettingsPersistenceBundle,
} from "@covel/shared/settings-persistence";

export type SettingsEntries = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isSettingsEntries(value: unknown): value is SettingsEntries {
  return isRecord(value);
}

/**
 * Load the entries from a SettingsStore JSON bundle. A missing file is the
 * fresh-install case; every other read or bundle-shape failure is deliberate:
 * returning an empty snapshot would make the next save destroy recoverable
 * user settings.
 */
export function readSettingsEntries(settingsFile: string): SettingsEntries {
  return readSettingsBundle(settingsFile).entries;
}

export function readSettingsBundle(
  settingsFile: string,
): SettingsPersistenceBundle {
  let raw: string;
  try {
    raw = fs.readFileSync(settingsFile, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return emptySettingsPersistenceBundle();
    }
    throw error;
  }

  return parseSettingsPersistenceBundle(JSON.parse(raw) as unknown);
}

/**
 * Atomically replace a valid settings bundle with a private file. Existing
 * files are read first so a local sidecar fallback never overwrites a corrupt
 * bundle with a partial in-memory SettingsStore snapshot.
 */
export function writeSettingsEntriesAtomic(
  settingsFile: string,
  entries: SettingsEntries,
  expectedRevision = 0,
): SettingsPersistenceBundle {
  if (!isSettingsEntries(entries)) {
    throw new Error("settings entries must be an object");
  }

  // Validates an existing file; ENOENT is intentionally accepted for a fresh
  // install. Do this before creating the parent directory or a temp file.
  const current = readSettingsBundle(settingsFile);
  if (current.revision !== expectedRevision) {
    const error = new Error(
      `Settings changed in another instance (revision ${current.revision})`,
    ) as Error & { code?: string; revision?: number };
    error.code = "settings_revision_conflict";
    error.revision = current.revision;
    throw error;
  }

  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  const temporaryFile = `${settingsFile}.${process.pid}.${randomUUID()}.tmp`;
  const bundle = nextSettingsPersistenceBundle(entries, current.revision);

  try {
    fs.writeFileSync(temporaryFile, JSON.stringify(bundle, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    // `mode` only applies on creation on POSIX. Re-assert it before the rename
    // so the replacement is private for its entire visible lifetime.
    fs.chmodSync(temporaryFile, 0o600);
    fs.renameSync(temporaryFile, settingsFile);
    // Keep the contract explicit on platforms where the rename may retain
    // destination metadata. This is a no-op on Windows but does not throw.
    fs.chmodSync(settingsFile, 0o600);
    return bundle;
  } catch (error) {
    try {
      fs.unlinkSync(temporaryFile);
    } catch {
      // Preserve the original write error.
    }
    throw error;
  }
}
