import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  emptySettingsPersistenceBundle,
  nextSettingsPersistenceBundle,
  unusableSettingsBundleLabel,
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
 * Load the current SettingsStore JSON bundle. A missing file is the
 * fresh-install case; every other read or bundle-shape failure is deliberate:
 * returning an empty snapshot would make the next save destroy recoverable
 * user settings.
 */
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

/** `settings.<label>.bak.json` beside the settings file, never an existing one. */
function freeBackupPath(settingsFile: string, label: string): string {
  const { dir, name, ext } = path.parse(settingsFile);
  const backup = path.join(dir, `${name}.${label}.bak${ext}`);
  if (!fs.existsSync(backup)) return backup;
  const timestamp = Date.now();
  for (let suffix = 0; ; suffix += 1) {
    const candidate = path.join(
      dir,
      `${name}.${label}.${timestamp}${suffix ? `.${suffix}` : ""}.bak${ext}`,
    );
    if (!fs.existsSync(candidate)) return candidate;
  }
}

/**
 * Move a settings file this build cannot use to `settings.<label>.bak.json`
 * beside it, and return that file name: an earlier format (`v1`), a file with
 * no version, or damaged text. While such a file stays in place every write
 * is refused, and the player has read-only defaults with no way out. A file
 * this build reads, one from a later build, and a file that is missing or
 * cannot be opened are left alone and return null.
 */
export function archiveUnusableSettingsFile(
  settingsFile: string,
): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(settingsFile, "utf-8");
  } catch {
    return null;
  }
  const label = unusableSettingsBundleLabel(raw);
  if (label === undefined) return null;
  const backup = freeBackupPath(settingsFile, label);
  fs.renameSync(settingsFile, backup);
  return path.basename(backup);
}

/**
 * Copy the settings file to `settings.<label>.bak.json` beside it and return
 * that file name. The renderer asks for the copy before it drops values that
 * the current settings refuse (`conflict`) and before a raw edit (`edit`).
 */
export function backupSettingsFile(
  settingsFile: string,
  label = "conflict",
): string {
  if (!/^[a-z]{1,16}$/.test(label)) throw new Error("invalid backup label");
  const backup = freeBackupPath(settingsFile, label);
  fs.copyFileSync(settingsFile, backup, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(backup, 0o600);
  return path.basename(backup);
}

function backupNamePattern(settingsFile: string): RegExp {
  const { name, ext } = path.parse(settingsFile);
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escape(name)}\\.[A-Za-z0-9.]+\\.bak${escape(ext)}$`);
}

/** The kept copies beside the settings file, by name. */
export function listSettingsBackups(settingsFile: string): string[] {
  const pattern = backupNamePattern(settingsFile);
  try {
    return fs
      .readdirSync(path.dirname(settingsFile))
      .filter((file) => pattern.test(file))
      .sort();
  } catch {
    return [];
  }
}

/** The text of one kept copy. A name that is not one of them reads nothing. */
export function readSettingsBackup(
  settingsFile: string,
  name: string,
): string | null {
  if (!listSettingsBackups(settingsFile).includes(name)) return null;
  return fs.readFileSync(path.join(path.dirname(settingsFile), name), "utf-8");
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
