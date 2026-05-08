export const STORAGE_MODE_KEY = "covel:storageMode";
export const APP_KV_MIGRATED_KEY = "covel:idbMigrated";
export const BROWSER_STORAGE_RESET_KEY = "covel:browserStorageReset:v1";
export const STATE_SNAPSHOT_PREFIX = "covel:stateSnapshot:";
export const WORLD_OVERLAY_PREFIX = "covel:worldOverlay:";

export const LEGACY_LOCAL_STORAGE_KEYS = [APP_KV_MIGRATED_KEY] as const;

export const LEGACY_LOCAL_STORAGE_PREFIXES = [
  STATE_SNAPSHOT_PREFIX,
  WORLD_OVERLAY_PREFIX,
] as const;

export const LEGACY_BROWSER_DATABASES = [
  "covel-game",
  "covel-app",
  "covel-media",
  "covel-media-store",
  "covel-store",
] as const;
