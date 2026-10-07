import {
  SettingsRevisionConflictError,
  type SettingsBackendAdapter,
} from "../types.js";
import {
  emptySettingsPersistenceBundle,
  nextSettingsPersistenceBundle,
  unusableSettingsBundleLabel,
  parseSettingsPersistenceBundle,
  type SettingsPersistenceBundle,
} from "@covel/shared/settings-persistence";

export const LOCAL_STORAGE_SETTINGS_KEY = "covel:settings";
export const LOCAL_STORAGE_KEYS_KEY = "covel:keys";

function readBundle(storage: Storage): SettingsPersistenceBundle {
  const raw = storage.getItem(LOCAL_STORAGE_SETTINGS_KEY);
  if (!raw) return emptySettingsPersistenceBundle();
  try {
    return parseSettingsPersistenceBundle(JSON.parse(raw) as unknown);
  } catch (error) {
    throw new Error(
      `settings localStorage bundle is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

const BACKUP_KEY = /^covel:settings\..+\.bak$/;

/** A backup key that holds nothing yet: an earlier copy is never written over. */
function freeBackupKey(storage: Storage, label: string): string {
  const key = `${LOCAL_STORAGE_SETTINGS_KEY}.${label}.bak`;
  if (storage.getItem(key) === null) return key;
  const timestamp = Date.now();
  for (let suffix = 0; ; suffix += 1) {
    const candidate = `${LOCAL_STORAGE_SETTINGS_KEY}.${label}.${timestamp}${suffix ? `.${suffix}` : ""}.bak`;
    if (storage.getItem(candidate) === null) return candidate;
  }
}

/**
 * Move a bundle this build cannot use to `covel:settings.<label>.bak`: an
 * earlier format, one without a version, or damaged text. The copy is written
 * before the original is removed, so a failed write (a full quota) leaves the
 * bundle in place and the store read-only.
 */
function archiveUnusableBundle(storage: Storage): string | null {
  const raw = storage.getItem(LOCAL_STORAGE_SETTINGS_KEY);
  if (!raw) return null;
  const label = unusableSettingsBundleLabel(raw);
  if (label === undefined) return null;
  const backupKey = freeBackupKey(storage, label);
  storage.setItem(backupKey, raw);
  storage.removeItem(LOCAL_STORAGE_SETTINGS_KEY);
  return backupKey;
}

function readSecrets(storage: Storage): Record<string, string> {
  const raw = storage.getItem(LOCAL_STORAGE_KEYS_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      throw new Error("keys bundle must be an object");
    }
    const entries = Object.entries(parsed as Record<string, unknown>);
    for (const [k, v] of entries) {
      if (typeof v !== "string") throw new Error(`key ${k} must be a string`);
    }
    return Object.fromEntries(entries) as Record<string, string>;
  } catch (error) {
    throw new Error(
      `settings localStorage keys are invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

interface LockManagerLike {
  request<T>(
    name: string,
    options: { mode: "exclusive" },
    callback: () => Promise<T>,
  ): Promise<T>;
}

function withSettingsLock<T>(
  operation: () => Promise<T>,
  required = false,
): Promise<T> {
  const locks = (
    globalThis.navigator as { locks?: LockManagerLike } | undefined
  )?.locks;
  if (!locks && required) {
    return Promise.reject(
      new Error(
        "Secret persistence requires Web Locks; use HTTPS or localhost in a supported browser",
      ),
    );
  }
  // Browsers without Web Locks still compare the revision immediately before
  // setItem. That detects stale writers but cannot make localStorage a true
  // cross-tab CAS primitive.
  return locks
    ? locks.request(
        "covel:settings-persistence",
        { mode: "exclusive" },
        operation,
      )
    : operation();
}

export function createLocalStorageBackend(
  storage: Storage = globalThis.localStorage,
): SettingsBackendAdapter {
  let archived: string | null = null;
  return {
    async load() {
      return (await this.loadWithRevision!()).entries;
    },
    async save(entries) {
      const current = readBundle(storage);
      await this.saveWithRevision!(entries, current.revision);
    },
    async loadWithRevision() {
      archived = archiveUnusableBundle(storage) ?? archived;
      return readBundle(storage);
    },
    async takeArchivedBundle() {
      const key = archived;
      archived = null;
      return key;
    },
    async backupBundle(label = "conflict") {
      const raw = storage.getItem(LOCAL_STORAGE_SETTINGS_KEY);
      if (!raw) throw new Error("[settings] there is no stored bundle to keep");
      const backupKey = freeBackupKey(storage, label);
      storage.setItem(backupKey, raw);
      return backupKey;
    },
    async listBackups() {
      const keys: string[] = [];
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key && BACKUP_KEY.test(key)) keys.push(key);
      }
      return keys.sort();
    },
    async readBackup(name) {
      return BACKUP_KEY.test(name) ? storage.getItem(name) : null;
    },
    async saveWithRevision(entries, expectedRevision) {
      return withSettingsLock(async () => {
        const current = readBundle(storage);
        if (current.revision !== expectedRevision) {
          throw new SettingsRevisionConflictError(current.revision);
        }
        const next = nextSettingsPersistenceBundle(entries, current.revision);
        storage.setItem(LOCAL_STORAGE_SETTINGS_KEY, JSON.stringify(next));
        return next;
      });
    },
    async loadSecrets() {
      return readSecrets(storage);
    },
    async saveSecrets(patch) {
      await withSettingsLock(async () => {
        const keys = new Map(Object.entries(readSecrets(storage)));
        for (const [provider, value] of Object.entries(patch)) {
          if (value === null) keys.delete(provider);
          else keys.set(provider, value);
        }
        storage.setItem(
          LOCAL_STORAGE_KEYS_KEY,
          JSON.stringify(Object.fromEntries(keys)),
        );
      }, true);
    },
  };
}
