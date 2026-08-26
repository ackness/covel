import {
  SettingsRevisionConflictError,
  type SettingKey,
  type SettingsBackendAdapter,
} from "../types.js";
import {
  emptySettingsPersistenceBundle,
  nextSettingsPersistenceBundle,
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
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v !== "string") throw new Error(`key ${k} must be a string`);
      out[k] = v;
    }
    return out;
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

function withSettingsLock<T>(operation: () => Promise<T>): Promise<T> {
  const locks = (
    globalThis.navigator as { locks?: LockManagerLike } | undefined
  )?.locks;
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
  return {
    async load() {
      return readBundle(storage).entries;
    },
    async save(entries) {
      const current = readBundle(storage);
      await this.saveWithRevision!(entries, current.revision);
    },
    async loadWithRevision() {
      return readBundle(storage);
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
    async saveSecrets(keys) {
      storage.setItem(LOCAL_STORAGE_KEYS_KEY, JSON.stringify(keys));
    },
  };
}
