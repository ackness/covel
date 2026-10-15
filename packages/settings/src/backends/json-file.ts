import {
  SettingsRevisionConflictError,
  type SettingKey,
  type SettingsBackendAdapter,
} from "../types.js";
import {
  parseSettingsPersistenceBundle,
  type SettingsPersistenceBundle,
} from "@covel/shared/settings-persistence";

export interface SettingsIpcTransport {
  invoke<T = unknown>(channel: string, payload?: unknown): Promise<T>;
}

function assertIpcWriteSucceeded(channel: string, result: unknown): void {
  if (
    result &&
    typeof result === "object" &&
    "ok" in result &&
    (result as { ok?: unknown }).ok === false
  ) {
    throw new Error(`[settings] IPC ${channel} failed`);
  }
}

function parseIpcBundle(value: unknown): SettingsPersistenceBundle {
  try {
    return parseSettingsPersistenceBundle(value);
  } catch (error) {
    throw new Error(
      `[settings] IPC settings bundle is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export interface JsonFileBackendOptions {
  /** Host-owned IPC transport, explicitly supplied by the desktop shell. */
  readonly ipc: SettingsIpcTransport;
}

/**
 * Desktop backend. Writes to `<covelHome>/settings.json` through the host's
 * Electron IPC bridge (`covel:settings:*` and `covel:keys:*` channels).
 */
export function createJsonFileBackend(
  opts: JsonFileBackendOptions,
): SettingsBackendAdapter {
  const { ipc } = opts;
  if (!ipc) {
    throw new Error("[settings] JSON file backend requires an IPC transport");
  }

  return {
    async load(): Promise<Record<SettingKey, unknown>> {
      return (await this.loadWithRevision!()).entries;
    },
    async loadWithRevision(): Promise<SettingsPersistenceBundle> {
      const raw = await ipc.invoke<unknown>("covel:settings:load");
      return parseIpcBundle(raw);
    },
    async save(entries): Promise<void> {
      const current = await this.loadWithRevision!();
      await this.saveWithRevision!(entries, current.revision);
    },
    async saveWithRevision(
      entries: Record<SettingKey, unknown>,
      expectedRevision: number,
    ): Promise<SettingsPersistenceBundle> {
      const result = await ipc.invoke<{
        ok?: unknown;
        code?: unknown;
        revision?: unknown;
        bundle?: unknown;
      }>("covel:settings:save", { entries, expectedRevision });
      if (
        result?.ok === false &&
        result.code === "settings_revision_conflict" &&
        typeof result.revision === "number"
      ) {
        throw new SettingsRevisionConflictError(result.revision);
      }
      assertIpcWriteSucceeded("covel:settings:save", result);
      return parseIpcBundle(result?.bundle);
    },
    async takeArchivedBundle(): Promise<string | null> {
      const file = await ipc.invoke<unknown>("covel:settings:archived");
      return typeof file === "string" && file.length > 0 ? file : null;
    },
    async backupBundle(label = "conflict"): Promise<string> {
      const file = await ipc.invoke<unknown>("covel:settings:backup", label);
      if (typeof file !== "string" || file.length === 0) {
        throw new Error("[settings] the host kept no copy of settings.json");
      }
      return file;
    },
    async listBackups(): Promise<readonly string[]> {
      const files = await ipc.invoke<unknown>("covel:settings:backups");
      return Array.isArray(files)
        ? files.filter((file): file is string => typeof file === "string")
        : [];
    },
    async readBackup(name: string): Promise<string | null> {
      const text = await ipc.invoke<unknown>(
        "covel:settings:read-backup",
        name,
      );
      return typeof text === "string" ? text : null;
    },
    async loadSecrets(): Promise<Record<string, string>> {
      const raw = await ipc.invoke<Record<string, string> | null>(
        "covel:keys:load",
      );
      return raw ?? {};
    },
    async saveSecrets(keys): Promise<void> {
      const result = await ipc.invoke("covel:keys:save", keys);
      assertIpcWriteSucceeded("covel:keys:save", result);
    },
  };
}
