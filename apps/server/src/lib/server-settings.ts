import {
  SERVER_SETTINGS,
  describeServerSetting,
  serverSettingDefinition,
  type ServerSettingInfo,
  type ServerSettingsSnapshot,
} from "@covel/shared";
import type { DataStore } from "@covel/store";

/**
 * How long a cached read is used before the database is asked again. Another
 * server process on the same database (PostgreSQL with several pods) may have
 * written a setting; this process then follows within this time.
 */
const REFRESH_AFTER_MS = 30_000;

type ServerSettingsBackend = Pick<
  DataStore,
  "listServerSettings" | "setServerSetting" | "deleteServerSetting"
>;

/** One validated change: a value to store, or `null` to drop the stored one. */
export type ServerSettingsPatch = Readonly<Record<string, unknown>>;

export class ServerSettingsValidationError extends Error {
  constructor(
    readonly code:
      | "invalid_server_settings_body"
      | "unknown_server_setting"
      | "invalid_server_setting_value"
      | "server_setting_fixed",
    message: string,
    readonly key?: string,
  ) {
    super(message);
    this.name = "ServerSettingsValidationError";
  }
}

/**
 * The server-scoped settings of this install, kept in the DataStore. Reads on
 * the hot path (`stored`) are synchronous and come from a cache: a setting is
 * consulted after every commit.
 */
export interface ServerSettings {
  /** Read the database into the cache. Await once before the first use. */
  load(): Promise<void>;
  /** The stored value of a key, or undefined. Starts a refresh when stale. */
  stored(key: string): unknown;
  /** Value in force, its source and whether it is settable, for every key. */
  describe(): ServerSettingsSnapshot;
  /**
   * Check a request body against the registry and return the patch to apply.
   * Throws {@link ServerSettingsValidationError}; nothing is written.
   */
  parsePatch(body: unknown): ServerSettingsPatch;
  /** Store a patch from {@link parsePatch} and refresh the cache. */
  write(patch: ServerSettingsPatch): Promise<void>;
}

export function createServerSettings(
  store: ServerSettingsBackend,
  now: () => number = Date.now,
): ServerSettings {
  let cache = new Map<string, unknown>();
  let loadedAt = Number.NEGATIVE_INFINITY;
  let refreshing: Promise<void> | null = null;

  async function load(): Promise<void> {
    const records = await store.listServerSettings();
    cache = new Map(records.map((record) => [record.key, record.value]));
    loadedAt = now();
  }

  function refreshWhenStale(): void {
    if (refreshing || now() - loadedAt < REFRESH_AFTER_MS) return;
    refreshing = load()
      .catch((error: unknown) => {
        // Keep the last values; do not ask again on every commit.
        loadedAt = now();
        console.warn("[server-settings] refresh failed:", error);
      })
      .finally(() => {
        refreshing = null;
      });
  }

  function info(key: string): ServerSettingInfo | undefined {
    const definition = serverSettingDefinition(key);
    return definition && describeServerSetting(definition, cache.get(key));
  }

  return {
    load,

    stored(key) {
      refreshWhenStale();
      return cache.get(key);
    },

    describe() {
      return {
        settings: Object.fromEntries(
          SERVER_SETTINGS.map((definition) => [
            definition.key,
            describeServerSetting(definition, cache.get(definition.key)),
          ]),
        ),
      };
    },

    parsePatch(body) {
      const entries =
        body && typeof body === "object" && !Array.isArray(body)
          ? (body as { entries?: unknown }).entries
          : undefined;
      if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
        throw new ServerSettingsValidationError(
          "invalid_server_settings_body",
          "Body must be { entries: { [key]: value | null } }",
        );
      }
      const patch: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(entries)) {
        const definition = serverSettingDefinition(key);
        if (!definition) {
          throw new ServerSettingsValidationError(
            "unknown_server_setting",
            `"${key}" is not a server setting`,
            key,
          );
        }
        if (info(key)?.source === "env") {
          throw new ServerSettingsValidationError(
            "server_setting_fixed",
            `"${key}" is fixed by the environment of this server`,
            key,
          );
        }
        if (value === null) {
          patch[key] = null;
          continue;
        }
        const parsed = definition.schema.safeParse(value);
        if (!parsed.success) {
          throw new ServerSettingsValidationError(
            "invalid_server_setting_value",
            `"${key}" does not accept this value`,
            key,
          );
        }
        patch[key] = parsed.data;
      }
      return patch;
    },

    async write(patch) {
      const updatedAt = new Date(now()).toISOString();
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) await store.deleteServerSetting(key);
        else await store.setServerSetting({ key, value, updatedAt });
      }
      await load();
    },
  };
}
